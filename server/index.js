// ── FxOrbit TradingView bridge ───────────────────────────────────────────────
// Streams realtime quotes + candles from TradingView (via the vendored
// @mathieuc/tradingview wrapper) to the FxOrbit frontend over WebSocket, and
// exposes small REST endpoints for health checks and one-off fetches.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  getCandles,
  watchCandles,
  getQuote,
  watchQuotes,
} from './vendor/Tradingview-API/dist/data/index.js';

const PORT = Number(process.env.TV_PORT || 5178);
// '::' = dual-stack, so ws://localhost and ws://127.0.0.1 both resolve
const HOST = process.env.TV_HOST || '::';
const HISTORY_COUNT = 300;
const MAX_CANDLES = 320;

// FxOrbit timeframe → TradingView timeframe
export const TF_TO_TV = { '1m': '1', '5m': '5', '15m': '15', '1H': '60', '4H': '240', '1D': 'D' };

const TV_INDICES = {
  US100: 'CAPITALCOM:US100', US500: 'CAPITALCOM:US500', US30: 'CAPITALCOM:US30',
  GER40: 'CAPITALCOM:GER40', UK100: 'CAPITALCOM:UK100', FR40: 'CAPITALCOM:FR40',
  JP225: 'FPMARKETS:JP225', HK50: 'CAPITALCOM:HK50',
};
const TV_STOCKS = new Set(['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META']);

export function toTvSymbol(sym) {
  if (TV_INDICES[sym]) return TV_INDICES[sym];
  if (TV_STOCKS.has(sym)) return `NASDAQ:${sym}`;
  return `FX:${sym.replace('/', '')}`;
}

// Normalize a TradingView candle into the FxOrbit serialization standard:
// unix-second time, plain floats, integer volume, ascending unique order.
function normCandle(c) {
  return {
    time: Math.floor(c.time),
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: Math.round(c.volume ?? 0),
  };
}

function normHistory(candles) {
  const sorted = [...candles].map(normCandle).sort((a, b) => a.time - b.time);
  const out = [];
  for (const c of sorted) {
    if (out.length && out[out.length - 1].time === c.time) out[out.length - 1] = c;
    else out.push(c);
  }
  while (out.length > MAX_CANDLES) out.shift();
  return out;
}

function normQuote(q) {
  return {
    price: q.lp ?? null,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    change: q.ch ?? null,
    changePct: q.chp ?? null,
    volume: q.volume != null ? Math.round(q.volume) : null,
    time: q.lp_time ?? null,
  };
}

// ── News proxy (ForexFactory calendar · Alpha Vantage / Finnhub headlines) ───
// Proxied server-side so the browser never hits a third-party CORS wall and the
// key only ever travels to localhost. Every provider is normalized into ONE
// item shape so the frontend has a single serialization standard:
//   { kind, feed, id, time: unixSeconds, title, summary, url, source,
//     impact: 'high'|'medium'|'low', sentiment, confidence, currencies: [],
//     topics?, currency?, actual?, estimate?, previous?, unit? }

const FH_BASE = process.env.FH_BASE || 'https://finnhub.io/api/v1';
const AV_BASE = process.env.AV_BASE || 'https://www.alphavantage.co/query';
const FF_URL = process.env.FF_BASE || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const AV_TOPICS = 'economy_monetary,economy_macro,economy_fiscal';
const NEWS_FRESH_MS = 5 * 60 * 1000;
const AV_FRESH_MS = 15 * 60 * 1000;

const IMPACT_BY_CODE = { H: 'high', HIGH: 'high', M: 'medium', MEDIUM: 'medium', L: 'low', LOW: 'low' };
const normImpact = (v) => IMPACT_BY_CODE[String(v ?? '').trim().toUpperCase()] ?? null;

const toUnix = (v) => {
  const n = typeof v === 'number' ? v * (v < 1e11 ? 1000 : 1) : Date.parse(v);
  return Number.isFinite(n) ? Math.floor(n / 1000) : null;
};

// Alpha Vantage stamps as YYYYMMDDTHHMMSS in UTC.
const avUnix = (v) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(v ?? ''));
  if (!m) return toUnix(v);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
};

const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNH', 'SEK', 'NOK', 'XAU', 'XAG'];
const AV_SENTIMENT_MAP = {
  bullish: 'bullish', 'somewhat-bullish': 'bullish',
  bearish: 'bearish', 'somewhat-bearish': 'bearish',
  neutral: 'neutral', 'unknown': 'neutral',
};
// Topic weight + sentiment magnitude + tier-1 macro keywords + FX linkage,
// scaled into one impact tier. Thresholds are set so only genuinely
// market-moving headlines reach `high`.
const AV_TOPIC_WEIGHT = { economy_monetary: 1, economy_fiscal: 0.8, economy_macro: 0.6 };
const AV_TIER1 = /\b(FED|FOMC|ECB|BOJ|BOE|SNB|RBA|central bank|interest rate|rate decision|CPI|PPI|inflation|payroll|unemployment|jobless|GDP|yield|treasur)\w*/i;
const AV_FX_LINK = /\b(dollar|euro|yen|pound|franc|loonie|aud|nzd|usd|eur|jpy|gbp|gold|silver|sterling|gilt|currency|fx)\b/i;

function avCurrencies(feed) {
  const out = new Set();
  for (const t of feed.ticker_sentiment ?? []) {
    const tk = String(t.ticker ?? '').toUpperCase();
    for (const c of CCYS) if (tk === c || tk.includes(c)) out.add(c);
  }
  const text = `${feed.title ?? ''} ${feed.summary ?? ''}`.toUpperCase();
  for (const c of CCYS) if (text.includes(c)) out.add(c);
  return [...out];
}

function avItem(feed) {
  const time = avUnix(feed.time_published);
  const title = String(feed.title ?? '').trim();
  const scoreRaw = Number(feed.overall_sentiment_score);
  const mag = Number.isFinite(scoreRaw) ? Math.abs(scoreRaw) : 0;
  const topics = (feed.topics ?? []).map((t) => String(t.topic ?? '').toLowerCase());
  const relevance = (feed.ticker_sentiment ?? []).reduce(
    (best, t) => Math.max(best, Number(t.relevance_score) || 0), 0,
  );

  let weight = 0.2;
  for (const t of topics) weight = Math.max(weight, AV_TOPIC_WEIGHT[t] ?? 0.2);
  const text = `${title} ${feed.summary ?? ''}`;
  const currencies = avCurrencies(feed);
  let score = weight + Math.min(0.8, mag);
  if (AV_TIER1.test(text)) score += 1.4;
  if (AV_FX_LINK.test(text)) score += 0.5;
  if (currencies.length && relevance > 0.7) score += 0.6;

  const impact = score >= 2.6 ? 'high' : score >= 1.7 ? 'medium' : 'low';
  const label = String(feed.overall_sentiment_label ?? '').toLowerCase();
  return {
    kind: 'headline',
    feed: 'news',
    id: `AV:${time}:${title}`,
    time,
    title,
    summary: String(feed.summary ?? '').trim(),
    url: feed.url ?? null,
    source: feed.source ?? null,
    topics,
    impact,
    sentiment: AV_SENTIMENT_MAP[label] ?? 'neutral',
    sentimentScore: Number.isFinite(scoreRaw) ? +scoreRaw.toFixed(3) : null,
    confidence: Math.min(92, Math.max(35, Math.round(40 + score * 14))),
    currencies,
  };
}

async function fhGet(path, params, token) {
  const url = new URL(FH_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  url.searchParams.set('token', token);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(body?.error ?? `Finnhub HTTP ${res.status}`));
  return body ?? {};
}

async function avItems({ token, topics, limit }) {
  const url = new URL(AV_BASE);
  url.searchParams.set('function', 'NEWS_SENTIMENT');
  url.searchParams.set('topics', topics || AV_TOPICS);
  url.searchParams.set('sort', 'LATEST');
  url.searchParams.set('limit', String(Math.min(1000, Math.max(50, Number(limit) || 200))));
  if (token) url.searchParams.set('apikey', token);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  if (body?.['Error Message']) throw new Error(String(body['Error Message']));
  if (body?.Information) throw new Error(String(body.Information));
  return (body?.feed ?? []).map(avItem).filter((i) => i.time && i.title).sort((a, b) => b.time - a.time);
}

async function finnhubItems({ token, category, from, to }) {
  const warnings = [];
  const items = [];

  try {
    const cal = await fhGet('/calendar/economic', { from, to }, token);
    for (const e of cal.economicCalendar ?? []) {
      const time = toUnix(e.time ?? e.date);
      const title = String(e.event ?? e.title ?? '').trim();
      if (!time || !title) continue;
      items.push({
        kind: 'event',
        feed: 'calendar',
        id: `EVT:${time}:${title}`,
        time,
        title,
        summary: '',
        url: null,
        source: e.country ?? null,
        topics: [],
        impact: normImpact(e.impact) ?? 'low',
        sentiment: 'neutral',
        sentimentScore: null,
        confidence: { high: 80, medium: 62, low: 48 }[normImpact(e.impact) ?? 'low'],
        currencies: String(e.currency ?? '').toUpperCase() ? [String(e.currency).toUpperCase()] : [],
        currency: String(e.currency ?? '').toUpperCase() || null,
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        previous: e.previous ?? e.prev ?? null,
        unit: e.unit ?? null,
      });
    }
  } catch (err) {
    warnings.push(`Economic calendar unavailable: ${err.message}`);
  }

  try {
    const news = await fhGet('/news', { category }, token);
    for (const n of news ?? []) {
      const time = toUnix(n.datetime ?? n.time);
      const title = String(n.headline ?? n.title ?? '').trim();
      if (!time || !title) continue;
      items.push({
        kind: 'headline',
        feed: 'news',
        id: `NEWS:${time}:${title}`,
        time,
        title,
        summary: String(n.summary ?? '').trim(),
        url: n.url ?? null,
        source: n.source ?? null,
        topics: [],
        impact: 'low',
        sentiment: 'neutral',
        sentimentScore: null,
        confidence: 50,
        currencies: avCurrencies({ title, summary: n.summary ?? '' }),
      });
    }
  } catch (err) {
    warnings.push(`Headlines unavailable: ${err.message}`);
  }

  return { items: items.sort((a, b) => b.time - a.time).slice(0, 200), warnings };
}

// ForexFactory publishes the whole week as one static JSON feed (keyless).
function ffItem(e) {
  const time = toUnix(e.date);
  const title = String(e.title ?? '').trim();
  const currency = String(e.country ?? '').toUpperCase() || null;
  const impact = normImpact(e.impact) ?? 'low';
  return {
    kind: 'event',
    feed: 'calendar',
    id: `FF:${time}:${title}`,
    time,
    title,
    summary: '',
    url: null,
    source: 'ForexFactory',
    topics: [],
    impact,
    sentiment: 'neutral',
    sentimentScore: null,
    confidence: { high: 80, medium: 62, low: 48 }[impact],
    currencies: currency ? [currency] : [],
    currency,
    actual: null,
    estimate: e.forecast ? String(e.forecast) : null,
    previous: e.previous ? String(e.previous) : null,
    unit: null,
  };
}

async function ffItems() {
  const res = await fetch(FF_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ForexFactory HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error('ForexFactory returned an unexpected payload');
  return body
    .filter((e) => String(e.impact ?? '').toLowerCase() !== 'holiday')
    .map(ffItem)
    .filter((i) => i.time && i.title);
}

// ── RSS headlines (keyless) ─────────────────────────────────────────────────
// FX/macro wires publish RSS with real publish times, so the desk can lead
// with genuinely current headlines instead of a quota-limited API that lags.
const RSS_FEEDS = [
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'CNBC Markets', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
];
const RSS_FRESH_MS = 3 * 60 * 1000;
const RSS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const RSS_HIGH = /\b(FED|FOMC|ECB|BOJ|BOE|SNB|RBA|RBNZ|CENTRAL BANK|INTEREST RATES?|RATE CUT|RATE HIKE|RATE DECISION|CPI|PPI|INFLATION|PAYROLLS?|NFP|UNEMPLOYMENT|JOBLESS|GDP|RECESSION|YIELDS?|TREASUR\w*|TARIFFS?|SANCTIONS?|INTERVENTION|DEFAULTS?|CRISIS)\b/i;
const RSS_MED = /\b(PMI|RETAIL|PRODUCTION|MANUFACTURING|TRADE|SENTIMENT|CONFIDENCE|BONDS?|STOCKS?|EQUITIES|EARNINGS|OILS?|GOLD|SILVER|DOLLAR|EURO|YEN|POUND|FRANC|BUDGET|HOUSING|CONSUMER|JOBS|EMPLOYMENT|INVENTORIES|CRYPTO|BITCOIN|NASDAQ|DOW)\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => ENTITIES[e.toLowerCase()]);

const rssText = (v) => decodeEntities(
  String(v ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
).replace(/\s+/g, ' ').trim();

const rssTag = (block, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? rssText(m[1]) : '';
};

// RSS stamps are RFC 822 ("Tue, 06 Oct 2026 10:01:00 GMT"); Investing.com
// emits a bare "YYYY-MM-DD HH:MM:SS" that must be read as UTC, not local.
function rssUnix(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const flat = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  const n = flat
    ? Date.parse(`${flat[1]}-${flat[2]}-${flat[3]}T${flat[4]}:${flat[5]}:${flat[6]}Z`)
    : Date.parse(s);
  return Number.isFinite(n) ? Math.floor(n / 1000) : null;
}

function rssItem(block, source) {
  const title = rssTag(block, 'title');
  if (!title) return null;
  const link = rssTag(block, 'link') || rssTag(block, 'guid') || null;
  const summary = rssTag(block, 'description').slice(0, 400);
  const time = rssUnix(rssTag(block, 'pubDate') || rssTag(block, 'published') || rssTag(block, 'updated'));
  if (!time) return null;
  const text = `${title} ${summary}`;
  const impact = RSS_HIGH.test(text) ? 'high' : RSS_MED.test(text) ? 'medium' : 'low';
  return {
    kind: 'headline',
    feed: 'news',
    id: `RSS:${link || `${source}:${title}`}`,
    time,
    title,
    summary,
    url: link,
    source,
    topics: [],
    impact,
    sentiment: 'neutral',
    sentimentScore: null,
    confidence: { high: 68, medium: 56, low: 46 }[impact],
    currencies: avCurrencies({ title, summary }),
  };
}

async function rssItems() {
  const warnings = [];
  const out = [];
  await Promise.all(RSS_FEEDS.map(async ({ name, url }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': RSS_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      let n = 0;
      for (const chunk of xml.split(/<item[\s>]/i).slice(1)) {
        const item = rssItem(chunk.split(/<\/item>/i)[0], name);
        if (item) { out.push(item); n += 1; }
      }
      if (!n) warnings.push(`${name}: no items parsed`);
    } catch (err) {
      warnings.push(`${name}: ${String(err?.message ?? err)}`);
    }
  }));
  if (!out.length) throw new Error(warnings.join(' · ') || 'No RSS items returned');
  const seen = new Set();
  return {
    items: out.sort((a, b) => b.time - a.time)
      .filter((i) => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }),
    warnings,
  };
}

// Free news tiers are quota-limited (Alpha Vantage: 25 requests/day), so good
// pulls are cached and stale data beats an empty desk when the quota runs out.
const newsCache = new Map();

async function cachedFeed(name, freshMs, load) {
  const hit = newsCache.get(name);
  if (hit && Date.now() - hit.at < freshMs) return { items: hit.items, warnings: hit.warnings ?? [], at: hit.at, stale: false };
  try {
    const loaded = await load();
    const items = Array.isArray(loaded) ? loaded : loaded.items;
    const extra = Array.isArray(loaded) ? [] : loaded.warnings ?? [];
    if (items.length) newsCache.set(name, { at: Date.now(), items, warnings: extra });
    return { items, warnings: extra, at: Date.now(), stale: false };
  } catch (err) {
    if (hit) return { items: hit.items, warnings: hit.warnings ?? [], at: hit.at, stale: true, error: String(err?.message ?? err) };
    throw err;
  }
}

async function newsFeed({ sources, token, newsProvider, topics, category, from, to }) {
  const want = String(sources || 'calendar,news').split(',').map((s) => s.trim()).filter(Boolean);
  const items = [];
  const warnings = [];
  const meta = {};

  if (want.includes('calendar')) {
    try {
      const r = await cachedFeed('ff', NEWS_FRESH_MS, ffItems);
      items.push(...r.items);
      meta.calendarAt = r.at;
    } catch (err) {
      warnings.push(`Economic calendar unavailable: ${err.message}`);
    }
  }

  if (want.includes('news')) {
    if (newsProvider === 'rss') {
      try {
        const r = await cachedFeed('rss', RSS_FRESH_MS, rssItems);
        items.push(...r.items);
        warnings.push(...r.warnings);
        meta.newsAt = r.at;
        if (r.stale) {
          warnings.push(`Headlines cached from ${new Date(r.at).toISOString().slice(11, 16)} UTC — upstream said: ${r.error}`);
        }
      } catch (err) {
        warnings.push(`Headlines unavailable: ${err.message}`);
      }
    } else if (!token) {
      warnings.push('Macro headlines need a news API key.');
    } else if (newsProvider === 'finnhub') {
      const r = await finnhubItems({ token, category, from, to });
      items.push(...r.items);
      warnings.push(...r.warnings);
      meta.newsAt = Date.now();
    } else {
      try {
        const r = await cachedFeed(`av:${token}:${topics || AV_TOPICS}`, AV_FRESH_MS, () => avItems({ token, topics }));
        items.push(...r.items);
        meta.newsAt = r.at;
        if (r.stale) {
          warnings.push(`Headlines cached from ${new Date(r.at).toISOString().slice(11, 16)} UTC — upstream said: ${r.error}`);
        }
      } catch (err) {
        warnings.push(`Headlines unavailable: ${err.message}`);
      }
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    deduped.push(i);
  }
  // Current and recent items lead the feed; scheduled events follow soonest-first,
  // so the desk reads what happened before what is coming.
  const nowSec = Math.floor(Date.now() / 1000);
  const past = deduped.filter((i) => i.time <= nowSec).sort((a, b) => b.time - a.time);
  const future = deduped.filter((i) => i.time > nowSec).sort((a, b) => a.time - b.time);
  return { items: [...past, ...future].slice(0, 200), warnings, meta };
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      ok: true,
      service: 'fxorbit-tv-bridge',
      uptimeSec: Math.round(process.uptime()),
      sockets: wss.clients.size,
    });
  }

  if (url.pathname === '/api/quote') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return json(res, 400, { ok: false, error: 'missing symbol' });
    try {
      const tvSymbol = toTvSymbol(symbol);
      const quote = await getQuote(tvSymbol);
      return json(res, 200, { ok: true, symbol, tvSymbol, quote: normQuote(quote) });
    } catch (err) {
      return json(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (url.pathname === '/api/candles') {
    const symbol = url.searchParams.get('symbol');
    const tf = url.searchParams.get('tf') || '1m';
    const count = Math.min(1000, Math.max(1, Number(url.searchParams.get('count')) || HISTORY_COUNT));
    if (!symbol || !TF_TO_TV[tf]) return json(res, 400, { ok: false, error: 'missing/unknown symbol or tf' });
    try {
      const tvSymbol = toTvSymbol(symbol);
      const candles = await getCandles({ symbol: tvSymbol, timeframe: TF_TO_TV[tf], count });
      return json(res, 200, { ok: true, symbol, tvSymbol, tf, candles: normHistory(candles) });
    } catch (err) {
      return json(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (url.pathname === '/api/news') {
    const day = 86400000;
    const now = Date.now();
    const date = (offset) => new Date(now + offset * day).toISOString().slice(0, 10);
    const params = {
      sources: url.searchParams.get('sources') || 'calendar,news',
      token: (url.searchParams.get('token') ?? '').trim(),
      newsProvider: ['finnhub', 'rss'].includes(url.searchParams.get('newsProvider')) ? url.searchParams.get('newsProvider') : 'alphavantage',
      topics: url.searchParams.get('topics') || undefined,
      category: url.searchParams.get('category') || 'forex',
      from: url.searchParams.get('from') || date(-1),
      to: url.searchParams.get('to') || date(7),
    };
    try {
      const feed = await newsFeed(params);
      return json(res, 200, {
        ok: true,
        fetchedAt: Math.floor(now / 1000),
        sources: params.sources,
        newsProvider: params.newsProvider,
        range: { from: params.from, to: params.to },
        ...feed,
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

// ── WebSocket feed ───────────────────────────────────────────────────────────
// Client → server: { type: 'subscribe', symbols: ['EUR/USD', ...], tfs: ['1m', ...] }
// Server → client: { type: 'history', symbol, tf, candles }
//                   { type: 'candle',  symbol, tf, candle }   (latest bar, on every update)
//                   { type: 'tick',    symbol, ...quote }
//                   { type: 'error',   symbol, tf?, message }

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const session = { candleWatchers: new Map(), quoteWatcher: null, subsKey: '' };

  const stopAll = async () => {
    for (const w of session.candleWatchers.values()) {
      try { await w.stop(); } catch { /* already stopped */ }
    }
    session.candleWatchers.clear();
    if (session.quoteWatcher) {
      try { await session.quoteWatcher.stop(); } catch { /* already stopped */ }
      session.quoteWatcher = null;
    }
  };

  const send = (msg) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  };

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type !== 'subscribe') return;
    const symbols = (msg.symbols ?? []).filter(Boolean);
    const tfs = (msg.tfs ?? []).filter((tf) => TF_TO_TV[tf]);
    const key = `${symbols.join(',')}|${tfs.join(',')}`;
    if (key === session.subsKey) return;
    session.subsKey = key;

    await stopAll();

    // Candle watchers: one per symbol × timeframe
    for (const symbol of symbols) {
      const tvSymbol = toTvSymbol(symbol);
      for (const tf of tfs) {
        try {
          const watcher = await watchCandles(
            { symbol: tvSymbol, timeframe: TF_TO_TV[tf], count: HISTORY_COUNT },
            {
              onData: (candles) => {
                const last = candles[candles.length - 1];
                if (!last) return;
                send({ type: 'candle', symbol, tf, candle: normCandle(last) });
              },
              onError: (err) => send({ type: 'error', symbol, tf, message: String(err?.message ?? err) }),
            },
          );
          session.candleWatchers.set(`${symbol}:${tf}`, watcher);
          send({ type: 'history', symbol, tf, candles: normHistory(watcher.latest) });
        } catch (err) {
          send({ type: 'error', symbol, tf, message: String(err?.message ?? err) });
        }
      }
    }

    // Quote watcher across all symbols
    if (symbols.length) {
      try {
        session.quoteWatcher = await watchQuotes(
          { symbols: symbols.map(toTvSymbol), fields: 'price' },
          {
            onData: (tvSymbol, quote) => {
              const symbol = symbols.find((s) => toTvSymbol(s) === tvSymbol) ?? tvSymbol;
              send({ type: 'tick', symbol, ...normQuote(quote) });
            },
            onError: (err) => send({ type: 'error', message: String(err?.message ?? err) }),
          },
        );
      } catch (err) {
        send({ type: 'error', message: String(err?.message ?? err) });
      }
    }

    send({ type: 'ready', symbols, tfs, tvSymbols: Object.fromEntries(symbols.map((s) => [s, toTvSymbol(s)])) });
  });

  socket.on('close', () => { void stopAll(); });
});

server.listen(PORT, HOST, () => {
  console.log(`[tv-bridge] FxOrbit TradingView bridge listening on http://${HOST}:${PORT}`);
  console.log(`[tv-bridge] REST: /api/status /api/quote /api/candles /api/news?token=…`);
  console.log('[tv-bridge] WS: /ws  { type: "subscribe", symbols, tfs }');
});
