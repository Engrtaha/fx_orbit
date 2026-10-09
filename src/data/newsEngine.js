// ── FxOrbit news desk ────────────────────────────────────────────────────────
// Live Finnhub news (proxied by the local bridge) → AI impact read → a trade
// plan the terminal then manages. With no AI key configured the desk heuristic
// produces the same shape, so the page stays usable offline.

import { engine, volatilityPips } from './marketEngine';
import { UNIVERSE, loadSettings } from './settings';
import { parseJsonLoose, aiReady, aiAuthHeaders } from '../utils/ai';

export const NEWS_PROVIDERS = [
  { id: 'rss', label: 'RSS — FXStreet / ForexLive / Investing.com', hint: 'no key needed · headlines land within minutes' },
  { id: 'alphavantage', label: 'Alpha Vantage — macro headlines + sentiment', hint: 'free key at alphavantage.co/support/#api-key · 25 requests/day' },
  { id: 'finnhub', label: 'Finnhub — economic calendar + headlines', hint: 'free key at finnhub.io/dashboard' },
];
export const NEWS_CATEGORIES = ['forex', 'economy', 'general', 'crypto'];
export const NEWS_SOURCE = 'News AI';
const CCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'XAU', 'XAG'];

const bridgeUrl = () => (loadSettings().tvBackendUrl || 'http://localhost:5178').replace(/\/+$/, '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export const itemTitle = (item) => item.event ?? item.title ?? 'Untitled item';
export const itemBlurb = (item) => item.summary || itemTitle(item);

// ── Universe scope ───────────────────────────────────────────────────────────
// Currency codes the enabled instruments are exposed to, so the desk can show
// only the news that actually moves the pairs the user trades.
export function universeCurrencies(pairs) {
  const list = pairs ?? loadSettings().pairs;
  const out = new Set();
  for (const sym of list) {
    const def = UNIVERSE.find((d) => d.symbol === sym);
    if (!def) continue;
    for (const c of [def.base, def.quote]) if (/^[A-Z]{3}$/.test(c)) out.add(c);
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
  const res = await fetch(`${bridgeUrl()}/api/news?${params.toString()}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `News fetch failed (HTTP ${res.status})`);
  const items = (body.items ?? []).filter((i) => i.time && i.title).sort((a, b) => b.time - a.time);
  if (!items.length) throw new Error((body.warnings ?? [])[0] ?? 'No news returned by the configured sources.');
  return { items, warnings: body.warnings ?? [], fetchedAt: body.fetchedAt, provider };
}

// ── Instrument selection ─────────────────────────────────────────────────────
function currenciesOf(item) {
  if (item.currencies?.length) return [...new Set(item.currencies.map((c) => String(c).toUpperCase()))];
  const text = `${item.currency ?? ''} ${itemTitle(item)} ${itemBlurb(item)}`.toUpperCase();
  const out = new Set();
  if (item.currency) out.add(String(item.currency).toUpperCase());
  for (const c of CCY_CODES) if (text.includes(c)) out.add(c);
  return [...out];
}

// Currency exposure of an instrument: USD indices/stocks quote in USD, metals
// carry XAU/XAG, so matching must read base/quote, not the symbol string.
const symbolCcys = (s) => [s.base, s.quote]
  .map((c) => String(c ?? '').toUpperCase())
  .filter((c) => /^[A-Z]{3}$/.test(c));

function symbolFor(item) {
  const snapshot = engine.getSnapshot();
  if (!snapshot.length) return null;
  const ccy = currenciesOf(item);
  const matched = snapshot.filter((s) => symbolCcys(s).some((c) => ccy.includes(c)));
  const pool = matched.length ? matched : snapshot;
  const { defaultPair } = loadSettings();
  if (defaultPair && pool.some((s) => s.symbol === defaultPair)) return defaultPair;
  return [...pool].sort((a, b) => volatilityPips(b) - volatilityPips(a))[0].symbol;
}

// The item's tone is about a CURRENCY; the pair direction follows the base side
// and flips when the tone is about the quote currency — bearish-USD news is
// bullish XAU/USD but bearish USD/JPY. Items with no tagged currency keep the
// raw tone, and indices get their USD quote from the universe catalog.
export function pairDirectionOf(sentiment, item, symbol) {
  if (!symbol || sentiment === 'neutral') return { symbol, direction: 'neutral' };
  const def = UNIVERSE.find((d) => d.symbol === symbol);
  const quote = def?.quote ?? symbol.split('/')[1];
  const about = String(item.currency ?? item.currencies?.[0] ?? '').toUpperCase();
  const flip = !!about && about === quote;
  return { symbol, direction: flip ? (sentiment === 'bullish' ? 'bearish' : 'bullish') : sentiment };
}

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
const BULLISH_KEYS = ['BEAT', 'RAISE', 'RAISED', 'HIGHER', 'STRONG', 'SURGE', 'GROWTH', 'EXPANSION', 'HIKE', 'TIGHTEN', 'OPTIMISTIC', 'RECORD', 'UPGRADE', 'GAIN', 'ROBUST', 'SOAR'];
const BEARISH_KEYS = ['MISS', 'MISSED', 'LOWER', 'WEAK', 'SLOW', 'CONTRACT', 'RECESSION', 'DOVISH', 'CUT', 'DOWNGRADE', 'FALL', 'SLUMP', 'PLUNGE', 'WEAKER', 'TUMBLE'];

const keywordImpact = (text) =>
  HIGH_RE.some((re) => re.test(text)) ? 'high'
  : MED_RE.some((re) => re.test(text)) ? 'medium' : 'low';

// Word-boundary prefix match — plain substring matching made "against" read as
// a GAIN hit and "moderate" as a RATE hit.
const keyRes = (keys) => keys.map((k) => new RegExp(`\\b${k}`));
const HIGH_RE = keyRes(HIGH_KEYS);
const MED_RE = keyRes(MED_KEYS);
const BULLISH_RE = keyRes(BULLISH_KEYS);
const BEARISH_RE = keyRes(BEARISH_KEYS);
const countHits = (text, res) => res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

function deskAnalysis(item) {
  const title = itemTitle(item).toUpperCase();
  const blurb = itemBlurb(item).toUpperCase();
  const impact = item.impact ?? keywordImpact(`${title} ${blurb}`);
  const actual = num(item.actual);
  const estimate = num(item.estimate) ?? num(item.previous);
  // Provider sentiment (Alpha Vantage scores headlines) leads the desk read.
  let score = item.sentiment === 'bullish' ? 2 : item.sentiment === 'bearish' ? -2 : 0;
  if (actual != null && estimate != null && actual !== estimate) score += actual > estimate ? 2 : -2;
  // The headline carries the signal; long RSS summaries mention both sides, so
  // they only tip the read when at least two of their words agree.
  score += countHits(title, BULLISH_RE) - countHits(title, BEARISH_RE);
  const tone = countHits(blurb, BULLISH_RE) - countHits(blurb, BEARISH_RE);
  if (Math.abs(tone) >= 2) score += Math.sign(tone);

  // The desk commits to a direction only on a tradable tier with an actual
  // edge — a random headline must not always turn into a BUY/SELL plan.
  const tradable = impact !== 'low' && score !== 0;
  const sentiment = tradable ? (score > 0 ? 'bullish' : 'bearish') : 'neutral';

  const symbol = symbolFor(item);
  const read = pairDirectionOf(sentiment, item, symbol);
  const side = read.direction === 'bullish' ? 'BUY' : read.direction === 'bearish' ? 'SELL' : null;
  const s = engine.getState(symbol);
  const vol = s ? Math.max(volatilityPips(s), s.spread * 2, 4) : 12;
  const mult = impact === 'high' ? 1.8 : impact === 'medium' ? 1.4 : 1;
  const slPips = +(vol * mult).toFixed(1);
  const tpPips = +(slPips * 1.75).toFixed(1);

  const surprise = actual != null && estimate != null && actual !== estimate
    ? ` Printed ${actual > estimate ? 'above' : 'below'} consensus (${actual} vs ${estimate}${item.unit ? ` ${item.unit}` : ''}), previous ${item.previous ?? 'n/a'}.`
    : '';
  const tape = s
    ? `${symbol} is trading at ${s.mid.toFixed(s.decimals)} with ${vol.toFixed(1)} pips of recent volatility.`
    : '';
  const summary = (tradable
    ? `${impact.toUpperCase()}-impact — the desk reads this ${read.direction.toUpperCase()} for ${symbol ?? 'the desk'} on "${itemTitle(item)}".${surprise} ${tape}`
    : impact === 'low'
      ? `LOW-impact item — "${itemTitle(item)}" sits below the desk's tradable threshold, so it stays flat.${surprise} ${tape}`
      : `${impact.toUpperCase()}-impact item, but "${itemTitle(item)}" carries no clear directional edge${symbol ? ` for ${symbol}` : ''} — the desk stands aside.${surprise} ${tape}`
  ).replace(/\s+/g, ' ').trim();
  return {
    impact,
    sentiment,
    confidence: clamp(52 + { high: 22, medium: 12, low: 5 }[impact] + Math.min(14, Math.abs(score) * 5), 40, 92),
    currencies: currenciesOf(item),
    summary,
    read,
    riskNote: 'Deterministic desk read — add an AI model key in Settings for real news analysis.',
    trade: tradable && side ? {
      symbol,
      side,
      slPips,
      tpPips,
      horizon: impact === 'high' ? 'hours' : '1-3 days',
      reasoning: `Impact tier ${impact} reads ${read.direction} for ${symbol}; stop and target sized at ${mult.toFixed(2)}× realised volatility.`,
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
  '{"impact":"high|medium|low","sentiment":"bullish|bearish|neutral","confidence":0-100,',
  '"currencies":["USD"],"summary":"2-3 sentences on what this means for the market and why",',
  '"trade":{"symbol":"EUR/USD","side":"BUY|SELL|WAIT","slPips":12.5,"tpPips":22,"horizon":"minutes|hours|1-3 days","reasoning":"1-2 sentences tied to this news","riskNote":"one sentence"}}',
  'Rules: trade.symbol MUST be one of the context symbols. slPips/tpPips are pips (0.0001 for most pairs, 0.01 for JPY pairs, 1 for indices).',
  'Size the stop from that instrument\'s volatilityPips, never from thin air. Use side WAIT when the item is already priced in or ambiguous.',
  'The summary MUST state explicitly which instrument the item is bullish or bearish for, and why. Respect quote-currency direction: a bearish-USD item is bullish for EUR/USD and XAU/USD but bearish for USD/JPY.',
  'Keep side and summary consistent: bullish for the instrument means side BUY, bearish means SELL.',
  'Never invent figures that are not present in the item.',
].join(' ');

async function callAnalyst(settings, item, context) {
  const allowed = context.map((c) => c.symbol).join(', ');
  const res = await fetch(`${settings.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
    body: JSON.stringify({
      model: settings.aiModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: `${ANALYST_SYSTEM} The only instruments you may use are: ${allowed}.` },
        { role: 'user', content: JSON.stringify({ item, market: context }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI model responded ${res.status}`);
  const data = await res.json();
  const parsed = parseJsonLoose(data.choices?.[0]?.message?.content ?? '');
  if (!parsed) throw new Error('Could not parse the model response.');
  return parsed;
}

// Clamp anything the model returns into a tradeable, engine-valid plan.
function normalizeAnalysis(raw, item) {
  const impact = ['high', 'medium', 'low'].includes(String(raw.impact).toLowerCase())
    ? String(raw.impact).toLowerCase() : (item.impact ?? 'medium');
  const sentiment = ['bullish', 'bearish', 'neutral'].includes(String(raw.sentiment).toLowerCase())
    ? String(raw.sentiment).toLowerCase() : 'neutral';
  const confidence = clamp(num(raw.confidence) ?? 55, 1, 99);
  const currencies = Array.isArray(raw.currencies) ? raw.currencies.map((c) => String(c).toUpperCase()) : currenciesOf(item);
  const t = raw.trade ?? raw.plan ?? null;
  const symbol = engine.getState(t?.symbol) ? t.symbol : symbolFor(item);
  const s = engine.getState(symbol);

  let side = String(t?.side ?? '').toUpperCase();
  if (!['BUY', 'SELL', 'WAIT'].includes(side)) {
    side = sentiment === 'bullish' ? 'BUY' : sentiment === 'bearish' ? 'SELL' : 'WAIT';
  }
  // The pair read is the instrument-level conclusion: the model's explicit side
  // when it commits, otherwise the tone mapped through quote-currency direction.
  const read = {
    symbol,
    direction: side === 'BUY' ? 'bullish' : side === 'SELL' ? 'bearish' : pairDirectionOf(sentiment, item, symbol).direction,
  };

  const base = {
    impact, sentiment, confidence, currencies,
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

export async function analyzeItem(item) {
  const settings = loadSettings();
  if (aiReady(settings)) {
    try {
      const raw = await callAnalyst(settings, item, marketContext());
      return { ...normalizeAnalysis(raw, item), simulated: false };
    } catch (err) {
      return { ...normalizeAnalysis(deskAnalysis(item), item), simulated: true, aiError: String(err?.message ?? err) };
    }
  }
  return { ...normalizeAnalysis(deskAnalysis(item), item), simulated: true };
}

// ── Trade placement + management ─────────────────────────────────────────────
export function placeNewsTrade(plan, item) {
  if (!plan) return null;
  return engine.openTrade({
    symbol: plan.symbol, side: plan.side, source: NEWS_SOURCE,
    slPips: plan.slPips, tpPips: plan.tpPips, note: itemTitle(item),
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
  engine.closeTrade(t, s ? s.mid : t.entry, 'Desk Close');
  return true;
}

export function tradeLive(t) {
  const s = engine.getState(t.symbol);
  const dir = t.side === 'BUY' ? 1 : -1;
  const mark = s ? s.mid : t.exit ?? t.entry;
  const pips = ((mark - t.entry) * dir) / (s ? s.pip : 0.0001);
  return { pips: +pips.toFixed(1), pnl: +(pips * (t.lots / 0.1)).toFixed(2) };
}

// High-impact news published AFTER a news trade opened that points the other way.
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
    const opposes = (trade.side === 'BUY' && a.sentiment === 'bearish')
      || (trade.side === 'SELL' && a.sentiment === 'bullish');
    if (opposes) flags.push({ itemId: item.id, title: itemTitle(item) });
  }
  return flags;
}
