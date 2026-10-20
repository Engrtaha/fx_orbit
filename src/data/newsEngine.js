// ── FxOrbit news desk ────────────────────────────────────────────────────────
// Live Finnhub news (proxied by the local bridge) → AI impact read → a trade
// plan the terminal then manages. With no AI key configured the desk heuristic
// produces the same shape, so the page stays usable offline.

import { engine, volatilityPips } from './marketEngine';
import { UNIVERSE, loadSettings } from './settings';
import {
  parseJsonLoose, aiReady, aiAuthHeaders, aiErrorText, aiJsonMode, aiModelOf, chatEndpoint,
} from '../utils/ai';
import { fetchJson, BRIDGE_TIMEOUT_MS, AI_TIMEOUT_MS } from '../utils/http';

export const NEWS_PROVIDERS = [
  { id: 'rss', label: 'RSS — FXStreet / ForexLive / Investing.com', hint: 'no key needed · headlines land within minutes' },
  { id: 'alphavantage', label: 'Alpha Vantage — macro headlines + sentiment', hint: 'free key at alphavantage.co/support/#api-key · 25 requests/day' },
  { id: 'finnhub', label: 'Finnhub — economic calendar + headlines', hint: 'free key at finnhub.io/dashboard' },
];
export const NEWS_CATEGORIES = ['forex', 'economy', 'general', 'crypto'];
export const NEWS_SOURCE = 'News AI';
const CCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'XAU', 'XAG',
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB'];

const bridgeUrl = () => (loadSettings().tvBackendUrl || 'http://localhost:5178').replace(/\/+$/, '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export const itemTitle = (item) => item.event ?? item.title ?? 'Untitled item';
export const itemBlurb = (item) => item.summary || itemTitle(item);

// ── Universe scope ───────────────────────────────────────────────────────────
// Currency codes the enabled instruments are exposed to, so the desk can show
// only the news that actually moves the pairs the user trades. Crypto tickers
// are 3-4 letters (DOGE), so the code test accepts both.
export function universeCurrencies(pairs) {
  const list = pairs ?? loadSettings().pairs;
  const out = new Set();
  for (const sym of list) {
    const def = UNIVERSE.find((d) => d.symbol === sym);
    if (!def) continue;
    for (const c of [def.base, def.quote]) if (/^[A-Z]{3,4}$/.test(c)) out.add(c);
  }
  return out;
}

export function itemInUniverse(item, ccys) {
  if (!ccys || ccys.size === 0) return true;
  const list = item.feed === 'calendar'
    ? [item.currency]
    : (item.currencies?.length ? item.currencies : []);
  return list.some((c) => c && ccys.has(String(c).toUpperCase()));
}

// ── Live feed ────────────────────────────────────────────────────────────────
// The economic calendar is keyless, so the desk always has data; macro
// headlines additionally use the configured provider key.
export async function fetchNewsFeed() {
  const settings = loadSettings();
  const token = (settings.newsApiKey || '').trim();
  const provider = settings.newsProvider || 'alphavantage';
  const params = new URLSearchParams({ token, newsProvider: provider, sources: 'calendar,news' });
  if (provider === 'finnhub') params.set('category', settings.newsCategory || 'forex');
  const body = await fetchJson(`${bridgeUrl()}/api/news?${params.toString()}`, { timeoutMs: BRIDGE_TIMEOUT_MS })
    .catch((err) => { throw new Error(`News fetch failed — ${err.message}`); });
  if (!body.ok) throw new Error(body.error ?? 'News fetch failed.');
  const items = (body.items ?? []).filter((i) => i.time && i.title).sort((a, b) => b.time - a.time);
  if (!items.length) throw new Error((body.warnings ?? [])[0] ?? 'No news returned by the configured sources.');
  return { items, warnings: body.warnings ?? [], fetchedAt: body.fetchedAt, provider };
}

// ── Subject detection ────────────────────────────────────────────────────────
// A headline's tone is about ONE thing — its subject — and the subject is what
// the headline names first: "Gold falls as dollar strengthens" is bearish GOLD.
// The feed's `currencies` list is no guide to that: it is built in a fixed
// USD-first order, so taking its first entry read the line above as a USD story,
// flipped it through XAU/USD's quote currency and called gold BULLISH.
//
// Names come before codes and multi-word names before single words, and every
// match is masked once found, so "Canadian dollar" is CAD and never also USD.
const NAME_PATTERNS = [
  ['US100', /\b(?:nasdaq(?:\s*100)?|nq)\b/gi],
  ['US500', /\b(?:s&p\s*500|s&p|spx)\b/gi],
  ['US30', /\b(?:dow jones|dow)\b/gi],
  ['GER40', /\b(?:dax|ger40)\b/gi],
  ['UK100', /\b(?:ftse(?:\s*100)?)\b/gi],
  ['JP225', /\b(?:nikkei(?:\s*225)?)\b/gi],
  ['HK50', /\b(?:hang seng)\b/gi],
  ['CAD', /\b(?:canadian dollar|loonie|bank of canada|boc)\b/gi],
  ['AUD', /\b(?:australian dollar|aussie dollar|aussie|rba|reserve bank of australia)\b/gi],
  ['NZD', /\b(?:new zealand dollar|kiwi|rbnz)\b/gi],
  ['SGD', /\b(?:singapore dollar)\b/gi],
  ['HKD', /\b(?:hong kong dollar)\b/gi],
  ['CHF', /\b(?:swiss franc|swissie|snb|franc)\b/gi],
  ['GBP', /\b(?:british pound|pound sterling|sterling|pound|cable|bank of england|boe|gilts?)\b/gi],
  ['JPY', /\b(?:japanese yen|yen|bank of japan|boj)\b/gi],
  ['EUR', /\b(?:euro area|eurozone|euro|ecb|lagarde)\b/gi],
  ['USD', /\b(?:u\.?s\.? dollar|us dollar|dollar|greenback|federal reserve|fomc|fed|powell|treasur(?:y|ies))\b/gi],
  ['XAU', /\b(?:gold|bullion)\b/gi],
  ['XAG', /\bsilver\b/gi],
  ['BTC', /\bbitcoin\b/gi],
  ['ETH', /\b(?:ethereum|ether)\b/gi],
  ['SOL', /\bsolana\b/gi],
  ['XRP', /\bripple\b/gi],
  ['DOGE', /\bdogecoin\b/gi],
  ['ADA', /\bcardano\b/gi],
];
const CODE_RE = new RegExp(`\\b(${CCY_CODES.join('|')})\\b`, 'g');
// EUR/USD or EURUSD — no free space between the legs, so "THE EUR/USD" can
// never be eaten as a THE/EUR pair before the real one is reached.
const PAIR_RE = /\b([A-Z]{3,4})\/?([A-Z]{3})\b/g;

const symbolDef = (sym) => UNIVERSE.find((d) => d.symbol === sym) ?? null;
const pairSymbol = (a, b) => UNIVERSE.find((d) => d.base === a && d.quote === b)?.symbol ?? null;

// Every currency/instrument a text names, in the order it names them.
// `symbol` entries are instruments named outright (EUR/USD, Nasdaq).
export function mentions(text) {
  let str = ` ${String(text ?? '')} `;
  const found = [];
  const mask = (m) => ' '.repeat(m.length);
  str = str.replace(PAIR_RE, (m, a, b, at) => {
    const sym = pairSymbol(a.toUpperCase(), b.toUpperCase());
    if (!sym) return m;
    found.push({ at, symbol: sym });
    return mask(m);
  });
  for (const [code, re] of NAME_PATTERNS) {
    str = str.replace(re, (m, at) => {
      found.push(symbolDef(code) ? { at, symbol: code } : { at, ccy: code });
      return mask(m);
    });
  }
  const upper = str.toUpperCase();
  for (const m of upper.matchAll(CODE_RE)) {
    // Codes only count when written as codes — "Eur" in prose is a word.
    if (str.slice(m.index, m.index + m[1].length) === m[1]) found.push({ at: m.index, ccy: m[1] });
  }
  return found.sort((a, b) => a.at - b.at);
}

function currenciesOf(item) {
  const out = new Set();
  if (item.currency) out.add(String(item.currency).toUpperCase());
  for (const m of mentions(`${itemTitle(item)} ${item.summary ?? ''}`)) {
    if (m.symbol) {
      const d = symbolDef(m.symbol);
      for (const c of [d?.base, d?.quote]) if (c && /^[A-Z]{3,4}$/.test(c)) out.add(c);
    } else out.add(m.ccy);
  }
  if (!out.size) for (const c of item.currencies ?? []) out.add(String(c).toUpperCase());
  return [...out];
}

// What the item's tone is about: { symbol } for an instrument named outright,
// { ccy } for a currency, {} when nothing is identifiable. Calendar releases are
// about their country's currency by definition.
export function subjectOf(item) {
  if (item?.subject && typeof item.subject === 'object') return item.subject;
  if (item?.feed === 'calendar' && item.currency) return { ccy: String(item.currency).toUpperCase() };
  const first = mentions(itemTitle(item ?? {}))[0] ?? mentions(item?.summary ?? '')[0];
  if (first) return first.symbol ? { symbol: first.symbol } : { ccy: first.ccy };
  const tagged = item?.currency ?? item?.currencies?.[0];
  return tagged ? { ccy: String(tagged).toUpperCase() } : {};
}

// Currency exposure of an instrument: USD indices/stocks quote in USD, metals
// carry XAU/XAG, so matching must read base/quote, not the symbol string.
const symbolCcys = (s) => [s.base, s.quote]
  .map((c) => String(c ?? '').toUpperCase())
  .filter((c) => /^[A-Z]{3,4}$/.test(c));

// FX and metals express a currency view directly; indices and stocks only
// through their quote currency, so they are the last resort.
const GROUP_RANK = { Major: 0, Metal: 1, Cross: 2, Exotic: 3, Crypto: 4, Index: 5, Stock: 6 };

// The instrument a news item is traded on — ALWAYS one that carries the item's
// subject. It used to fall back to the default pair for anything else, so a
// Canadian-dollar headline sold US100 on a desk with no CAD pair at all.
function symbolFor(item, subject = subjectOf(item)) {
  const snapshot = engine.getSnapshot();
  if (!snapshot.length) return null;
  if (subject.symbol && snapshot.some((s) => s.symbol === subject.symbol)) return subject.symbol;
  const ccy = subject.ccy ?? (subject.symbol ? symbolDef(subject.symbol)?.base : null);
  if (!ccy) return null;
  const pool = snapshot.filter((s) => symbolCcys(s).includes(ccy));
  if (!pool.length) return null;
  const { defaultPair } = loadSettings();
  if (defaultPair && pool.some((s) => s.symbol === defaultPair)) return defaultPair;
  return [...pool].sort((a, b) => ((GROUP_RANK[a.group] ?? 9) - (GROUP_RANK[b.group] ?? 9))
    || (volatilityPips(b) - volatilityPips(a)))[0].symbol;
}

// The item's tone is about its SUBJECT; the pair direction follows the base side
// and flips when the subject is the quote currency — bearish-USD news is bullish
// XAU/USD but bearish USD/JPY. A subject the instrument does not carry says
// nothing about it (neutral); items with no identifiable subject keep the raw
// tone, and indices get their USD quote from the universe catalog.
export function pairDirectionOf(sentiment, item, symbol, subject = subjectOf(item ?? {})) {
  if (!symbol || sentiment === 'neutral') return { symbol, direction: 'neutral' };
  if (subject.symbol === symbol) return { symbol, direction: sentiment };
  const ccy = subject.ccy ?? (subject.symbol ? symbolDef(subject.symbol)?.base : null);
  if (!ccy) return { symbol, direction: sentiment };
  const def = symbolDef(symbol);
  const base = String(def?.base ?? symbol.split('/')[0]).toUpperCase();
  const quote = String(def?.quote ?? symbol.split('/')[1] ?? '').toUpperCase();
  if (ccy === base) return { symbol, direction: sentiment };
  if (ccy === quote) return { symbol, direction: sentiment === 'bullish' ? 'bearish' : 'bullish' };
  return { symbol, direction: 'neutral' };
}

export const subjectLabel = (subject) => subject?.symbol ?? subject?.ccy ?? null;

function marketContext() {
  return engine.getSnapshot().map((s) => ({
    symbol: s.symbol,
    price: +s.mid.toFixed(s.decimals),
    changePct: +s.changePct.toFixed(2),
    rsi: +s.rsi.toFixed(1),
    spreadPips: +s.spread.toFixed(1),
    volatilityPips: +volatilityPips(s).toFixed(1),
    pip: s.pip,
  }));
}

// ── Desk heuristic (no AI key) ───────────────────────────────────────────────
const HIGH_KEYS = ['RATE', 'INTEREST', 'FOMC', 'CPI', 'INFLATION', 'NFP', 'JOBS', 'UNEMPLOY', 'GDP', 'INTERVENTION', 'ELECTION', 'CENTRAL BANK'];
const MED_KEYS = ['RETAIL', 'PPI', 'PMI', 'MANUFACTURING', 'TRADE', 'HOUSING', 'CONSUMER', 'CONFIDENCE', 'AUCTION', 'EMPLOYMENT', 'INDUSTRIAL'];
// Word-start keys; a trailing $ means the whole word, so ROSE is not Rosengren
// (a Fed official), MISS is not missile and FELL is not fellow.
const BULLISH_KEYS = ['BEAT', 'RAISE', 'HIGHER', 'STRONG', 'STRENGTH', 'SURGE', 'GROWTH', 'EXPANSION', 'HIKE', 'TIGHTEN', 'OPTIMISTIC', 'RECORD', 'UPGRADE', 'GAIN', 'ROBUST', 'SOAR', 'RALL', 'CLIMB', 'RISE', 'RISING', 'ROSE$', 'JUMP', 'HAWKISH', 'REBOUND', 'RECOVER'];
const BEARISH_KEYS = ['MISS$', 'MISSES$', 'MISSED$', 'LOWER', 'WEAK', 'SLOW', 'CONTRACT', 'RECESSION', 'DOVISH', 'CUT', 'DOWNGRADE', 'FALL', 'FELL$', 'SLUMP', 'PLUNGE', 'TUMBLE', 'DROP', 'SLIDE', 'SLID$', 'SLIP', 'SINK', 'SANK$', 'DECLINE', 'RETREAT', 'SOFTER', 'EASE', 'EASING', 'SELLOFF', 'SELL-OFF', 'CRASH'];

// Releases where a HIGHER print is bad for the currency. Scoring them like CPI
// called a jump in unemployment or jobless claims bullish.
const INVERTED = /\b(?:UNEMPLOY|JOBLESS|CLAIMS)/;

const keywordImpact = (text) =>
  HIGH_RE.some((re) => re.test(text)) ? 'high'
  : MED_RE.some((re) => re.test(text)) ? 'medium' : 'low';

// Word-boundary prefix match — plain substring matching made "against" read as
// a GAIN hit and "moderate" as a RATE hit.
const keyRes = (keys) => keys.map((k) => new RegExp(`\\b${k}`));
const HIGH_RE = keyRes(HIGH_KEYS);
const MED_RE = keyRes(MED_KEYS);
const wordIs = (word, keys) => keys.some((k) => (k.endsWith('$') ? word === k.slice(0, -1) : word.startsWith(k)));

// Words that turn the next few words around: "fails to rally", "halts slide",
// "pares gains", "no rate cut". Not "ends" — "stocks end higher" is no negation.
const NEGATORS = /^(?:NOT|NO|NEVER|FAILS?|FAILED|UNABLE|HALTS?|HALTED|PARES?|PARED|ERASES?|ERASED|SNAPS?|SNAPPED)$/;
const NEGATION_REACH = 3;
// Extremes read as one call: "18-month lows" is bearish, "record high" bullish —
// RECORD alone would otherwise score "record low" as bullish.
const EXTREME = '(?:RECORD|ALL-TIME|MULTI-YEAR|FRESH|NEW|\\d+-(?:DAY|WEEK|MONTH|YEAR))';
const BULL_PHRASE = new RegExp(`\\b${EXTREME}\\s+HIGHS?\\b`, 'g');
const BEAR_PHRASE = new RegExp(`\\b${EXTREME}\\s+LOWS?\\b`, 'g');

// Net tone of an UPPERCASE text: +1 per bullish word, -1 per bearish word, each
// word counted once (WEAKER used to hit both WEAK and WEAKER).
export function toneOf(text) {
  const words = String(text)
    .replace(BULL_PHRASE, ' ~BULL ')
    .replace(BEAR_PHRASE, ' ~BEAR ')
    .split(/[^A-Z0-9~'-]+/)
    .filter(Boolean);
  let score = 0;
  let reach = -1;
  words.forEach((w, i) => {
    if (NEGATORS.test(w)) { reach = i + NEGATION_REACH; return; }
    let v = w === '~BULL' ? 1 : w === '~BEAR' ? -1 : wordIs(w, BULLISH_KEYS) ? 1 : wordIs(w, BEARISH_KEYS) ? -1 : 0;
    if (v && i <= reach) v = -v;
    score += v;
  });
  return score;
}

// The verb next to the subject carries its tone: in "Gold falls as dollar
// strengthens" FALL is gold's and STRENGTH is the dollar's. The title is cut at
// its first connective and the subject's clause scored on its own.
const CLAUSE_BREAK = /\s(?:as|while|after|amid|despite|but|on|with|ahead of|before|since|because)\s|[,;:–—]|\s-\s/i;
function headlineTone(title) {
  const lead = title.split(CLAUSE_BREAK)[0];
  const own = toneOf(lead);
  return own !== 0 ? own : toneOf(title);
}

// "4.2%", "215K", "-0.3", "1,250" → comparable numbers (same unit on both sides).
const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
export function figure(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*([KMBT])?\s*%?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (SCALE[m[2]?.toUpperCase()] ?? 1);
  return Number.isFinite(n) ? n : null;
}

export function deskAnalysis(item) {
  const title = itemTitle(item).toUpperCase();
  const blurb = itemBlurb(item).toUpperCase();
  const impact = item.impact ?? keywordImpact(`${title} ${blurb}`);
  const actual = figure(item.actual);
  const estimate = figure(item.estimate) ?? figure(item.previous);
  const inverted = INVERTED.test(title);
  const sign = inverted ? -1 : 1;
  // Provider sentiment (Alpha Vantage scores headlines) leads the desk read.
  let score = item.sentiment === 'bullish' ? 2 : item.sentiment === 'bearish' ? -2 : 0;
  if (actual != null && estimate != null && actual !== estimate) score += sign * (actual > estimate ? 2 : -2);
  // The headline carries the signal; long RSS summaries mention both sides, so
  // they only tip the read when at least two of their words agree. "Jobless
  // claims fall" is good news, so inverted releases flip their wording too.
  score += sign * headlineTone(title);
  const tone = toneOf(blurb);
  if (Math.abs(tone) >= 2) score += sign * Math.sign(tone);

  // The desk commits to a direction only on a tradable tier with an actual
  // edge — a random headline must not always turn into a BUY/SELL plan.
  const edge = impact !== 'low' && score !== 0;
  const sentiment = edge ? (score > 0 ? 'bullish' : 'bearish') : 'neutral';

  const subject = subjectOf(item);
  const about = subjectLabel(subject);
  const symbol = symbolFor(item, subject);
  const read = pairDirectionOf(sentiment, item, symbol, subject);
  const side = read.direction === 'bullish' ? 'BUY' : read.direction === 'bearish' ? 'SELL' : null;
  const tradable = edge && !!side;
  const s = engine.getState(symbol);
  const vol = s ? Math.max(volatilityPips(s), s.spread * 2, 4) : 12;
  const mult = impact === 'high' ? 1.8 : impact === 'medium' ? 1.4 : 1;
  const slPips = +(vol * mult).toFixed(1);
  const tpPips = +(slPips * 1.75).toFixed(1);

  const surprise = actual != null && estimate != null && actual !== estimate
    ? ` Printed ${actual > estimate ? 'above' : 'below'} consensus (${item.actual} vs ${item.estimate ?? item.previous}${item.unit ? ` ${item.unit}` : ''}), previous ${item.previous ?? 'n/a'}${inverted ? ' — a higher print is bad news for the currency' : ''}.`
    : '';
  const tape = s
    ? `${symbol} is trading at ${s.mid.toFixed(s.decimals)} with ${vol.toFixed(1)} pips of recent volatility.`
    : '';
  const why = about && symbol && about !== symbol ? ` (${sentiment} ${about})` : '';
  const summary = (tradable
    ? `${impact.toUpperCase()}-impact — the desk reads this ${read.direction.toUpperCase()} for ${symbol}${why} on "${itemTitle(item)}".${surprise} ${tape}`
    : impact === 'low'
      ? `LOW-impact item — "${itemTitle(item)}" sits below the desk's tradable threshold, so it stays flat.${surprise} ${tape}`
      : edge && !symbol
        ? `${impact.toUpperCase()}-impact and ${sentiment} ${about ?? 'in tone'}, but none of your enabled instruments carries ${about ?? 'its subject'} — the desk stands aside.${surprise}`
        : `${impact.toUpperCase()}-impact item, but "${itemTitle(item)}" carries no clear directional edge${symbol ? ` for ${symbol}` : ''} — the desk stands aside.${surprise} ${tape}`
  ).replace(/\s+/g, ' ').trim();
  return {
    impact,
    sentiment,
    subject,
    confidence: clamp(52 + { high: 22, medium: 12, low: 5 }[impact] + Math.min(14, Math.abs(score) * 5), 40, 92),
    currencies: currenciesOf(item),
    summary,
    read,
    riskNote: 'Deterministic desk read — add an AI model key in Settings for real news analysis.',
    trade: tradable ? {
      symbol,
      side,
      slPips,
      tpPips,
      horizon: impact === 'high' ? 'hours' : '1-3 days',
      reasoning: `Impact tier ${impact} reads ${sentiment} ${about ?? ''}, which is ${read.direction} for ${symbol}; stop and target sized at ${mult.toFixed(2)}× realised volatility.`.replace(/\s+/g, ' '),
      riskNote: 'Desk heuristic — position size to your Risk Per Trade setting.',
    } : null,
    simulated: true,
  };
}

// ── AI analyst ───────────────────────────────────────────────────────────────
const ANALYST_SYSTEM = [
  'You are FxOrbit, a macro news-desk analyst inside a live trading terminal.',
  'You receive ONE news item (an economic-calendar release or a macro headline) plus live market context for the instruments this terminal trades.',
  'The item may carry provider-assigned fields (impact, sentiment, sentimentScore, topics, forecast, previous). Treat them as inputs to weigh, not as the answer: re-derive the tier from how market-moving the event actually is.',
  'Judge the market impact of that single item and produce ONE trade idea on exactly one instrument from the context list.',
  'Respond with ONLY a JSON object, no markdown and no prose, shaped:',
  '{"subject":"USD","impact":"high|medium|low","sentiment":"bullish|bearish|neutral","confidence":0-100,',
  '"currencies":["USD"],"summary":"2-3 sentences on what this means for the market and why",',
  '"trade":{"symbol":"EUR/USD","side":"BUY|SELL|WAIT","slPips":12.5,"tpPips":22,"horizon":"minutes|hours|1-3 days","reasoning":"1-2 sentences tied to this news","riskNote":"one sentence"}}',
  'Rules: trade.symbol MUST be one of the context symbols. slPips/tpPips are pips (0.0001 for most pairs, 0.01 for JPY pairs, 1 for indices).',
  'Size the stop from that instrument\'s volatilityPips, never from thin air. Use side WAIT when the item is already priced in or ambiguous.',
  '"subject" is the ONE currency code (USD, EUR, XAU…) or instrument symbol the item is about — what the headline names first. "Gold falls as the dollar strengthens" has subject XAU.',
  '"sentiment" is the tone for that SUBJECT, not for the instrument you trade: a strong US jobs report is bullish USD; rising unemployment or jobless claims is bearish for that currency.',
  'trade.symbol must carry the subject (as base or quote). Respect quote-currency direction: a bearish-USD item is bullish for EUR/USD and XAU/USD (side BUY) but bearish for USD/JPY (side SELL).',
  'The summary MUST state explicitly which instrument the item is bullish or bearish for, and why.',
  'Never invent figures that are not present in the item.',
].join(' ');

async function callAnalyst(settings, item, context) {
  const allowed = context.map((c) => c.symbol).join(', ');
  const body = await fetchJson(chatEndpoint(settings), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
    body: JSON.stringify({
      model: aiModelOf(settings),
      temperature: 0.2,
      ...aiJsonMode(settings),
      messages: [
        { role: 'system', content: `${ANALYST_SYSTEM} The only instruments you may use are: ${allowed}.` },
        { role: 'user', content: JSON.stringify({ item, market: context }) },
      ],
    }),
    timeoutMs: AI_TIMEOUT_MS,
  });
  const parsed = parseJsonLoose(body.choices?.[0]?.message?.content ?? '');
  if (!parsed) throw new Error('Could not parse the model response.');
  return parsed;
}

// A subject the model names, as a currency code or an instrument in the universe.
function subjectFromModel(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!v) return null;
  const sym = UNIVERSE.find((d) => d.symbol.toUpperCase() === v)?.symbol;
  if (sym) return { symbol: sym };
  return /^[A-Z]{3,4}$/.test(v) ? { ccy: v } : null;
}

// Clamp anything the model returns into a tradeable, engine-valid plan.
//
// The pair direction is DERIVED, not trusted: the subject's tone mapped through
// the traded instrument's base/quote. Small local models routinely get that flip
// backwards — "bearish USD" with SELL XAU/USD — which is exactly the
// bullish-when-it-is-bearish read. The model's own side is used only when the
// subject is not on the instrument it picked.
function normalizeAnalysis(raw, item) {
  const impact = ['high', 'medium', 'low'].includes(String(raw.impact).toLowerCase())
    ? String(raw.impact).toLowerCase() : (item.impact ?? 'medium');
  const sentiment = ['bullish', 'bearish', 'neutral'].includes(String(raw.sentiment).toLowerCase())
    ? String(raw.sentiment).toLowerCase() : 'neutral';
  const confidence = clamp(num(raw.confidence) ?? 55, 1, 99);
  const currencies = Array.isArray(raw.currencies) ? raw.currencies.map((c) => String(c).toUpperCase()) : currenciesOf(item);
  const subject = (raw.subject && typeof raw.subject === 'object' ? raw.subject : subjectFromModel(raw.subject))
    ?? subjectOf(item);
  const t = raw.trade ?? raw.plan ?? null;
  const symbol = engine.getState(t?.symbol) ? t.symbol : symbolFor(item, subject);
  const s = engine.getState(symbol);

  const modelSide = String(t?.side ?? '').toUpperCase();
  const derived = pairDirectionOf(sentiment, item, symbol, subject);
  const ccy = subject.ccy ?? (subject.symbol ? UNIVERSE.find((d) => d.symbol === subject.symbol)?.base : null);
  const carried = !!s && (subject.symbol === symbol || symbolCcys(s).includes(ccy));
  let direction = derived.direction;
  if (!carried) {
    direction = modelSide === 'BUY' ? 'bullish' : modelSide === 'SELL' ? 'bearish' : derived.direction;
  }
  const side = modelSide === 'WAIT' || direction === 'neutral'
    ? 'WAIT'
    : direction === 'bullish' ? 'BUY' : 'SELL';
  const read = { symbol, direction };

  const base = {
    impact, sentiment, subject, confidence, currencies,
    summary: String(raw.summary ?? itemBlurb(item)).slice(0, 900),
    read,
    trade: null,
  };
  if (!s || side === 'WAIT') return base;

  const vol = Math.max(volatilityPips(s), s.spread * 2, 4);
  const slPips = clamp(num(t?.slPips) ?? vol * 1.6, 2, 500);
  const tpPips = clamp(num(t?.tpPips) ?? slPips * 1.75, slPips * 1.1, 900);
  const dir = side === 'BUY' ? 1 : -1;
  const entry = s.mid;
  return {
    ...base,
    trade: {
      symbol,
      side,
      slPips: +slPips.toFixed(1),
      tpPips: +tpPips.toFixed(1),
      entry,
      sl: entry - dir * slPips * s.pip,
      tp: entry + dir * tpPips * s.pip,
      rr: +(tpPips / slPips).toFixed(2),
      decimals: s.decimals,
      pip: s.pip,
      horizon: String(t?.horizon ?? 'hours').slice(0, 40),
      reasoning: String(t?.reasoning ?? raw.summary ?? '').slice(0, 500),
      riskNote: String(t?.riskNote ?? raw.riskNote ?? 'News trades can gap against you — size to your risk setting.').slice(0, 300),
    },
  };
}

// Small local models often return "sentiment":"neutral" next to a summary that
// says "This is bullish for CAD" (Llama 3.2 3B did exactly that on "CAD gains
// against US Dollar"). A neutral field is reconciled before it is believed: the
// direction the model's own summary states wins, else the desk's keyword read
// when it has a clear edge. A model that commits to a direction is never
// overridden.
const STATED = /\b(bullish|bearish)\s+(?:for|on|towards?)\s+(?:the\s+)?([A-Z]{3,4}(?:\/[A-Z]{3})?)\b/i;
export function reconcileNeutral(raw, item) {
  const tone = String(raw?.sentiment ?? '').toLowerCase();
  if (tone === 'bullish' || tone === 'bearish') return raw;
  const stated = STATED.exec(String(raw?.summary ?? ''));
  const unpinned = raw?.trade ? { ...raw.trade, side: '' } : raw?.trade;
  if (stated) {
    const target = stated[2].toUpperCase();
    const subject = UNIVERSE.some((d) => d.symbol === target) ? { symbol: target } : { ccy: target };
    return { ...raw, sentiment: stated[1].toLowerCase(), subject, trade: unpinned, reconciled: 'summary' };
  }
  const desk = deskAnalysis(item);
  if (desk.sentiment !== 'neutral') {
    return { ...raw, sentiment: desk.sentiment, subject: desk.subject, trade: unpinned, reconciled: 'desk' };
  }
  return raw;
}

export async function analyzeItem(item) {
  const settings = loadSettings();
  if (aiReady(settings)) {
    try {
      const raw = reconcileNeutral(await callAnalyst(settings, item, marketContext()), item);
      return { ...normalizeAnalysis(raw, item), simulated: false, reconciled: raw.reconciled ?? null };
    } catch (err) {
      return { ...normalizeAnalysis(deskAnalysis(item), item), simulated: true, aiError: aiErrorText(settings, err) };
    }
  }
  return { ...normalizeAnalysis(deskAnalysis(item), item), simulated: true };
}

// ── Trade placement + management ─────────────────────────────────────────────
// A news trade is held for the horizon the desk planned it on, not the engine's
// 4-hour default: a "1-3 days" read time-stopped after hours never played out.
const HORIZON_HOLD_MS = { minutes: 3600e3, hours: 8 * 3600e3, '1-3 days': 72 * 3600e3 };
export const newsHoldMs = (horizon) => {
  const h = String(horizon ?? '').toLowerCase();
  if (HORIZON_HOLD_MS[h]) return HORIZON_HOLD_MS[h];
  if (/day/.test(h)) return HORIZON_HOLD_MS['1-3 days'];
  if (/min/.test(h)) return HORIZON_HOLD_MS.minutes;
  return HORIZON_HOLD_MS.hours;
};

export function placeNewsTrade(plan, item) {
  if (!plan) return null;
  return engine.openTrade({
    symbol: plan.symbol, side: plan.side, source: NEWS_SOURCE,
    slPips: plan.slPips, tpPips: plan.tpPips, note: itemTitle(item),
    maxHoldMs: newsHoldMs(plan.horizon),
  });
}

export function newsTrades() {
  const all = engine.getTrades().filter((t) => t.source === NEWS_SOURCE);
  return { open: all.filter((t) => t.status === 'open'), closed: all.filter((t) => t.status === 'closed') };
}

export function closeNewsTrade(id) {
  const t = engine.getTrades().find((x) => x.id === id);
  if (!t || t.status !== 'open') return false;
  const s = engine.getState(t.symbol);
  // Only a live print is a fill; the simulated walk would book made-up P&L.
  engine.closeTrade(t, s?.tv ? s.mid : t.entry, 'Desk Close');
  return true;
}

export function tradeLive(t) {
  const s = engine.getState(t.symbol);
  const mark = s ? s.mid : (t.exit || t.entry);
  // Priced in the instrument's own pip and contract (engine.pnlAt): the old
  // 0.0001 guess was 100x wrong for JPY crosses and 10000x for DOGE, and a flat
  // $10/pip was 10x off for an index.
  const { pips, pnl } = engine.pnlAt(t, mark);
  return { pips: +pips.toFixed(1), pnl: +pnl.toFixed(2) };
}

// High-impact news published AFTER a news trade opened that points the other way
// FOR THE TRADED INSTRUMENT. Comparing the item's raw tone with the trade side
// flagged bearish-USD news as a threat to a long XAU/USD it actually supports.
export function riskFlags(trade, items, analyses) {
  const s = engine.getState(trade.symbol);
  if (!s) return [];
  const flags = [];
  for (const item of items) {
    if (item.time * 1000 < trade.openedAt) continue;
    const a = analyses[item.id];
    if (!a || a.impact !== 'high') continue;
    const touchesCcy = currenciesOf(item).some((c) => c === s.base || c === s.quote);
    if (!touchesCcy) continue;
    const { direction } = pairDirectionOf(a.sentiment, item, trade.symbol, a.subject ?? subjectOf(item));
    const opposes = (trade.side === 'BUY' && direction === 'bearish')
      || (trade.side === 'SELL' && direction === 'bullish');
    if (opposes) flags.push({ itemId: item.id, title: itemTitle(item) });
  }
  return flags;
}
