// ── TraderMagic bot client ───────────────────────────────────────────────────
// rawveg/trader-magic runs its own loop on this machine: it polls TAAPI.io for
// RSI, asks its own Ollama model for a "buy"/"sell"/"hold" call, and publishes
// the result as GET /api/data from its Flask dashboard. The bot answers no
// prompts, so this is the only surface that can use it — it supplies decisions,
// never analysis text.

import { volatilityPips } from './marketEngine';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Number(null) is 0, which would read a missing RSI or timestamp as a real one.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Keys the dashboard mixes into the same object alongside its symbol rows.
const INTERNAL_KEYS = new Set(['_system', '_debug', '_trade_results']);

// The bot's free TAAPI tier polls one symbol every 15 s and its own default
// POLL_INTERVAL is 300 s, so a row older than a few cycles is not a live call.
export const TM_STALE_MS = 15 * 60 * 1000;

const DECISION_SIDE = { buy: 'LONG', sell: 'SHORT', hold: 'WAIT' };

export const tmBase = (settings) =>
  String(settings?.aiBaseUrl ?? '').trim().replace(/\/+$/, '') || 'http://localhost:9753';

export async function fetchTmData(settings, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${tmBase(settings)}/api/data`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`TraderMagic responded ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== 'object' || data.error) {
      throw new Error(String(data?.error ?? 'TraderMagic returned no data'));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function tmEntries(data) {
  return Object.entries(data ?? {})
    .filter(([key]) => !INTERNAL_KEYS.has(key))
    .map(([key, row]) => ({ key, ...(row && typeof row === 'object' ? row : {}) }));
}

// The bot keys rows by its own spelling ("AAPL", "BTC/USD"); only a row naming
// an instrument this terminal actually trades is usable, and universe scoping
// means never reaching outside the enabled pairs.
export function tmPairFor(key, pairs = []) {
  const raw = String(key ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const flat = raw.replace('/', '');
  return pairs.find((p) => {
    const s = String(p).toUpperCase();
    return s === raw || s.replace('/', '') === flat;
  }) ?? null;
}

export function tmFindEntry(data, symbol, pairs) {
  return tmEntries(data).find((e) => tmPairFor(e.symbol ?? e.key, pairs) === symbol) ?? null;
}

export function tmAgeMs(entry, now = Date.now()) {
  const ts = num(entry?.timestamp);
  if (ts == null) return null;
  // The bot writes seconds; a value that large is already milliseconds.
  const ms = ts > 1e11 ? ts : ts * 1000;
  return now - ms;
}

// RSI is the bot's entire evidence base, so conviction scales with how far it
// sits from the 50 midline and saturates at the usual 30/70 extremes.
export function tmConfidence(rsi) {
  const v = num(rsi);
  if (v == null) return 50;
  return Math.round(clamp(50 + (Math.abs(v - 50) / 20) * 40, 5, 95));
}

// Same shape and the same level math as signalEngine.normalizeSignal, so the
// active-signal book, chart price lines and progress bars need no special case.
export function normalizeTmSignal(entry, s, tf) {
  const decision = String(entry?.signal ?? '').trim().toLowerCase();
  const side = DECISION_SIDE[decision] ?? 'WAIT';
  const rsi = num(entry.rsi);
  const age = tmAgeMs(entry);
  const stale = age != null && age > TM_STALE_MS;
  const reasons = [];
  if (rsi != null) reasons.push(`TraderMagic RSI ${rsi.toFixed(1)}`);
  if (entry.price != null && num(entry.price) != null) reasons.push(`Bot price ${num(entry.price)}`);
  reasons.push(`Decision "${decision || 'none'}" from the bot's own model`);
  if (stale) reasons.push(`Row is ${Math.round(age / 60000)} min old — the bot is not polling live`);

  const base = {
    symbol: s.symbol,
    tf,
    side: stale ? 'WAIT' : side,
    confidence: tmConfidence(rsi),
    reasons: reasons.slice(0, 3),
    summary: `TraderMagic's RSI loop decided "${decision || 'nothing usable'}" for ${s.symbol}.`,
    decimals: s.decimals,
    source: 'TraderMagic',
    stale,
  };
  if (base.side === 'WAIT') {
    return { ...base, entry: s.mid, sl: null, tp: null, rr: null, slPips: null, tpPips: null };
  }

  const vol = Math.max(volatilityPips(s), s.spread * 2, 4);
  const slPips = clamp(vol * 1.4, vol * 0.5, vol * 3.5);
  const tpPips = slPips * 2.5;
  const dir = base.side === 'LONG' ? 1 : -1;
  const entryPrice = s.mid;
  return {
    ...base,
    entry: entryPrice,
    slPips: +slPips.toFixed(1),
    tpPips: +tpPips.toFixed(1),
    sl: entryPrice - dir * slPips * s.pip,
    tp: entryPrice + dir * tpPips * s.pip,
    rr: +(tpPips / slPips).toFixed(2),
  };
}
