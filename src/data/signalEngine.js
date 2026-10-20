// ── FxOrbit signal engine ────────────────────────────────────────────────────
// Turns the live state of ONE instrument into an actionable signal. With an AI
// provider configured the model reads the real stats; otherwise the terminal's
// own engine math produces the same shape, so the page stays usable offline.

import {
  engine, latestReversal, reversalLabel, symbolMarketClosed, tfPeriodMs, volatilityPips,
} from './marketEngine';
import { loadSettings } from './settings';
import {
  parseJsonLoose, aiReady, aiAuthHeaders, aiErrorText, aiModelOf, aiJsonMode, chatEndpoint,
} from '../utils/ai';
import { fetchJson, AI_TIMEOUT_MS } from '../utils/http';
import {
  SETUPS, isReversalBook, strategyMaxHoldMs, strategyRewardRisk,
} from '../utils/riskReward';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// The engine's default target when neither the strategy nor the model names one.
export const DEFAULT_RR = 2.5;

const SIGNAL_SYSTEM = [
  'You are the signal engine of a trading terminal. You receive live stats for ONE instrument',
  '(price, RSI, 1-minute momentum, spread, volatility, ATR, and the last 10 candles of the requested timeframe)',
  'and must output ONE actionable signal on that instrument.',
  'Respond with ONLY a JSON object, no markdown and no prose, shaped:',
  '{"side":"LONG|SHORT|WAIT","confidence":0-100,"slPips":12.5,"tpPips":22,',
  '"reasons":["max 3 short reasons citing the given stats"],"summary":"one sentence"}',
  'Rules: side LONG means buy, SHORT means sell. Use WAIT when the evidence conflicts or the spread/volatility makes the trade poor.',
  'slPips/tpPips are in pips: scale the stop from volatilityPips (roughly 1-2x). For indices 1 pip = 1 point.',
  'When targetRewardRisk is given, tpPips MUST equal slPips x targetRewardRisk (the strategy\'s own R:R); otherwise target at least 2.5x the stop.',
  'When instrument.reversal is present, a reversal printed on the last closed bars (a liquidity sweep rejected, or RSI exhaustion broken):',
  'it is the primary setup — side SHORT for a bearish reversal, LONG for a bullish one — with the stop beyond reversal.extreme,',
  'unless the strategy rules forbid counter-trend trades. An overbought RSI is NOT a reason to buy on its own.',
  'Confidence reflects how strongly the evidence supports the side; a WAIT signal gets low confidence.',
  'Never invent figures that are not derivable from the given stats.',
].join(' ');

const strategyText = (strategy) => (typeof strategy === 'string' ? strategy : strategy?.rules ?? '');

// A book that trades tops and bottoms — or no book at all — acts on a fresh
// reversal. A pure trend-following book only hears about it as a reason.
export const actsOnReversal = (strategy) => {
  if (strategy && typeof strategy === 'object' && SETUPS.includes(strategy.setup)) return strategy.setup === 'reversal';
  return !strategyText(strategy) || isReversalBook(strategyText(strategy));
};

function signalContext(s, tf, reversal) {
  const d = engine.getDetail(s);
  return {
    symbol: s.symbol,
    timeframe: tf,
    price: +s.mid.toFixed(s.decimals),
    changePct: +s.changePct.toFixed(2),
    rsi: +s.rsi.toFixed(1),
    momentumPct: +s.momentum.toFixed(3),
    score: s.score,
    spreadPips: +s.spread.toFixed(1),
    volatilityPips: +volatilityPips(s).toFixed(1),
    atr: +d.atr.toFixed(s.decimals),
    pip: s.pip,
    reversal: reversal ? {
      side: reversal.side,
      kind: reversal.kind,
      level: +reversal.level.toFixed(s.decimals),
      extreme: +reversal.extreme.toFixed(s.decimals),
    } : null,
    recentBars: engine.getCandles(s.symbol, tf).slice(-10).map((c) => ({
      o: c.open, h: c.high, l: c.low, c: c.close,
    })),
  };
}

async function callSignalModel(settings, payload) {
  const body = await fetchJson(chatEndpoint(settings), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
    body: JSON.stringify({
      model: aiModelOf(settings),
      temperature: 0.2,
      ...aiJsonMode(settings),
      messages: [
        { role: 'system', content: SIGNAL_SYSTEM },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
    timeoutMs: AI_TIMEOUT_MS,
  });
  const parsed = parseJsonLoose(body.choices?.[0]?.message?.content ?? '');
  if (!parsed) throw new Error('Could not parse the model response.');
  return parsed;
}

// Clamp anything the model returns into an engine-valid signal. `rr` is the
// strategy's own reward:risk — when set it decides the target, not the model.
export function normalizeSignal(raw, s, tf, { rr = null } = {}) {
  const sideRaw = String(raw?.side ?? '').toUpperCase();
  const side = ['LONG', 'SHORT', 'WAIT'].includes(sideRaw)
    ? sideRaw
    : (s.score >= 1 ? 'LONG' : s.score <= -1 ? 'SHORT' : 'WAIT');
  const confidence = clamp(num(raw?.confidence) ?? s.confidence, 1, 99);
  const reasons = (Array.isArray(raw?.reasons) ? raw.reasons : [])
    .map((r) => String(r).slice(0, 140)).filter(Boolean).slice(0, 3);

  const base = {
    symbol: s.symbol,
    tf,
    side,
    confidence,
    reasons: reasons.length ? reasons : [`RSI ${s.rsi.toFixed(0)}`, `1m momentum ${s.momentum.toFixed(3)}%`, `Volatility ${volatilityPips(s).toFixed(1)} pips`],
    summary: String(raw?.summary ?? '').slice(0, 300),
    decimals: s.decimals,
  };
  if (side === 'WAIT') {
    return { ...base, entry: s.mid, sl: null, tp: null, rr: null, slPips: null, tpPips: null };
  }

  const vol = Math.max(volatilityPips(s), s.spread * 2, 4);
  const slPips = clamp(num(raw?.slPips) ?? vol * 1.4, vol * 0.5, vol * 3.5);
  const tpPips = rr
    ? slPips * rr
    : clamp(num(raw?.tpPips) ?? slPips * DEFAULT_RR, slPips * 2, slPips * 6);
  return { ...base, ...levels(s, side, slPips, tpPips) };
}

function levels(s, side, slPips, tpPips) {
  const dir = side === 'LONG' ? 1 : -1;
  const entry = s.mid;
  return {
    entry,
    slPips: +slPips.toFixed(1),
    tpPips: +tpPips.toFixed(1),
    sl: entry - dir * slPips * s.pip,
    tp: entry + dir * tpPips * s.pip,
    rr: +(tpPips / slPips).toFixed(2),
  };
}

// Engine-math signal: the momentum read, unless a fresh reversal printed and
// the book trades reversals — then the reversal's side, with the stop parked
// beyond the swept extreme instead of an arbitrary ATR distance.
function engineSignal(s, tf, { rr, reversal }) {
  const d = engine.getDetail(s);
  const target = rr ?? DEFAULT_RR;
  if (reversal) {
    const beyond = reversal.side === 'SHORT' ? reversal.extreme - s.mid : s.mid - reversal.extreme;
    const slDist = Math.max(beyond + 0.25 * d.atr, 0.5 * d.atr, s.spread * 2 * s.pip);
    const slPips = slDist / s.pip;
    return {
      side: reversal.side,
      ...levels(s, reversal.side, slPips, slPips * target),
      reasons: [
        `${reversalLabel(reversal)} at ${reversal.level.toFixed(s.decimals)}`,
        ...d.reasons.slice(0, 3),
      ],
    };
  }
  const slPips = d.slPips;
  return {
    side: d.side,
    ...levels(s, d.side === 'SHORT' ? 'SHORT' : 'LONG', slPips, slPips * target),
    reasons: d.reasons.slice(0, 4),
  };
}

export async function generateAiSignal(symbol, tf, strategy) {
  const s = engine.getState(symbol);
  if (!s) return null;
  const settings = loadSettings();
  // Read real bars, not the walk: the signal's timeframe (its recent bars and
  // reversal) and the 15m chart its stop distance comes from.
  if (s.tv && engine.historyLoader) {
    await Promise.all([...new Set([tf, '15m'])]
      .filter((t) => t !== '1m' && !s.liveTfs?.has(t))
      .map((t) => Promise.resolve(engine.historyLoader(symbol, t)).catch(() => null)));
  }
  const rr = strategyRewardRisk(strategy); // the book's rr field, else its rule text
  const printed = latestReversal(engine.getCandles(symbol, tf), s.mid);
  const reversal = printed && actsOnReversal(strategy) ? printed : null;
  const eng = engineSignal(s, tf, { rr, reversal });
  const tag = printed ? { side: printed.side, kind: printed.kind, label: reversalLabel(printed) } : null;
  const fallback = {
    symbol,
    tf,
    ...eng,
    confidence: reversal ? Math.max(s.confidence, 62) : s.confidence,
    summary: reversal
      ? `${reversalLabel(reversal)} on the ${tf} chart — engine-derived levels with the stop beyond the swept extreme.`
      : 'Engine-derived signal from live RSI, momentum, spread and session liquidity.',
    decimals: s.decimals,
    reversal: tag,
    simulated: true,
  };
  if (fallback.side === 'WAIT') Object.assign(fallback, { sl: null, tp: null, rr: null, slPips: null, tpPips: null });
  if (!aiReady(settings)) return fallback;
  try {
    const payload = { instrument: signalContext(s, tf, printed) };
    if (strategy) payload.strategy = strategy;
    if (rr) payload.targetRewardRisk = rr;
    const raw = await callSignalModel(settings, payload);
    return { ...normalizeSignal(raw, s, tf, { rr }), reversal: tag, simulated: false };
  } catch (err) {
    return { ...fallback, aiError: aiErrorText(settings, err) };
  }
}

// ── Active signal book ───────────────────────────────────────────────────────
// A generated LONG/SHORT signal stays "active" until live price touches its
// SL or TP. Active signals render on the Signals page and as level lines on
// the Charts page; when one closes, the desk immediately generates a fresh
// signal for the same instrument so the cycle keeps running.

const SIGNALS_KEY = 'fxorbit-signals';
const MAX_CLOSED = 20;
// A signal no longer waits forever for its TP or SL: after the book's own hold
// time — or 16 bars of its timeframe (4h on 15m, the trades' default) — the
// setup is stale, so it closes as "expired" at the live price and the desk
// generates the next one.
const SIGNAL_BARS = 16;
export const signalLifetimeMs = (sig) => strategyMaxHoldMs(sig?.strategyRules) ?? SIGNAL_BARS * tfPeriodMs(sig?.tf);
export const signalExpiresAt = (sig) => (Number(sig?.expiresAt) > 0
  ? Number(sig.expiresAt)
  : (Number(sig?.createdAt) || Date.now()) + signalLifetimeMs(sig));

let book = null;
let ticking = false;
const listeners = new Set();

function loadBook() {
  try {
    const raw = localStorage.getItem(SIGNALS_KEY);
    if (!raw) return { active: [], closed: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { active: [], closed: [] };
    // An entry missing its levels would render `fmt(undefined)` and, worse, could
    // never be scored for a TP/SL hit — so it would sit in the book forever.
    const active = Array.isArray(parsed.active) ? parsed.active.filter(isLiveSignal) : [];
    const closed = Array.isArray(parsed.closed) ? parsed.closed.filter(isOutcome) : [];
    return { active, closed };
  } catch { /* corrupted or unavailable — start fresh */ }
  return { active: [], closed: [] };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function isLiveSignal(s) {
  return !!s && typeof s.id === 'string' && typeof s.symbol === 'string'
    && (s.side === 'LONG' || s.side === 'SHORT')
    && finite(s.entry) && finite(s.sl) && finite(s.tp) && finite(s.decimals);
}

function isOutcome(o) {
  return !!o && typeof o.symbol === 'string'
    && (o.status === 'tp' || o.status === 'sl' || o.status === 'expired')
    && finite(o.pips) && finite(o.closedAt);
}

const state = () => (book ??= loadBook());

function emit() {
  try { localStorage.setItem(SIGNALS_KEY, JSON.stringify(book)); } catch { /* storage full/blocked */ }
  listeners.forEach((fn) => fn());
}

export function subscribeSignals(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function activeSignals() {
  return state().active;
}

export function activeSignalFor(symbol) {
  return state().active.find((s) => s.symbol === symbol) ?? null;
}

export function recentOutcomes(limit = 5) {
  return state().closed.slice(0, limit);
}

export function saveSignal(result, mode = 'ai') {
  if (!result || result.side === 'WAIT' || result.sl == null || result.tp == null) return null;
  const sig = {
    id: `SIG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: result.symbol,
    tf: result.tf,
    side: result.side,
    entry: result.entry,
    sl: result.sl,
    tp: result.tp,
    slPips: result.slPips,
    tpPips: result.tpPips,
    rr: result.rr,
    confidence: result.confidence,
    summary: result.summary ?? '',
    strategyRules: result.strategyRules ?? null,
    reversal: result.reversal ?? null,
    mode,
    decimals: result.decimals,
    createdAt: Date.now(),
  };
  sig.expiresAt = sig.createdAt + signalLifetimeMs(sig);
  state().active = [...state().active.filter((s) => s.symbol !== sig.symbol), sig];
  emit();
  return sig;
}

async function regenerate(prev) {
  if (!engine.getState(prev.symbol)) return;
  const next = await generateAiSignal(prev.symbol, prev.tf, prev.strategyRules);
  if (next && next.side !== 'WAIT' && next.sl != null && next.tp != null) {
    saveSignal({ ...next, strategyRules: prev.strategyRules }, prev.mode);
  }
}

function outcomePips(sig, outcome, price) {
  if (outcome === 'tp') return sig.tpPips;
  if (outcome === 'sl') return -sig.slPips;
  const pip = engine.pipFor(sig.symbol);
  const dir = sig.side === 'LONG' ? 1 : -1;
  return +(((price - sig.entry) * dir) / pip).toFixed(1);
}

async function closeSignal(sig, outcome, price) {
  const st = state();
  st.active = st.active.filter((s) => s.id !== sig.id);
  st.closed = [
    { ...sig, status: outcome, exitPrice: price, pips: outcomePips(sig, outcome, price), closedAt: Date.now() },
    ...st.closed,
  ].slice(0, MAX_CLOSED);
  emit();
  await regenerate(sig);
}

// Re-entry guarded: regeneration may call the model for seconds, and ticks
// arrive on a 1s interval — overlapping runs would spam the provider.
export async function tickSignals() {
  if (ticking) return;
  ticking = true;
  try {
    for (const sig of [...state().active]) {
      // A held FX signal stays exactly as it was while the tape is shut — there
      // is no live price to score a TP/SL hit against. Crypto signals tick on,
      // their market never closes.
      if (symbolMarketClosed(sig.symbol).closed) continue;
      const s = engine.getState(sig.symbol);
      if (!s) continue;
      const hitSl = sig.side === 'LONG' ? s.mid <= sig.sl : s.mid >= sig.sl;
      const hitTp = sig.side === 'LONG' ? s.mid >= sig.tp : s.mid <= sig.tp;
      if (hitSl) await closeSignal(sig, 'sl', s.mid);
      else if (hitTp) await closeSignal(sig, 'tp', s.mid);
      else if (Date.now() >= signalExpiresAt(sig)) await closeSignal(sig, 'expired', s.mid);
    }
  } finally {
    ticking = false;
  }
}

// Live progress of an active signal: pips in profit right now, plus a 0..1
// fraction of the way from entry to target (used for the progress bar).
export function signalProgress(sig) {
  const s = engine.getState(sig.symbol);
  if (!s) return { mid: null, pips: 0, frac: 0, pip: 1, decimals: 5 };
  const dir = sig.side === 'LONG' ? 1 : -1;
  const pips = ((s.mid - sig.entry) * dir) / s.pip;
  const span = Math.abs(sig.tp - sig.entry) || 1;
  const frac = Math.min(1, Math.max(0, ((s.mid - sig.entry) * dir) / span));
  return { mid: s.mid, pips: +pips.toFixed(1), frac, pip: s.pip, decimals: s.decimals };
}
