// ── FxOrbit signal engine ────────────────────────────────────────────────────
// Turns the live state of ONE instrument into an actionable signal. With an AI
// provider configured the model reads the real stats; otherwise the terminal's
// own engine math produces the same shape, so the page stays usable offline.

import { engine, volatilityPips } from './marketEngine';
import { loadSettings } from './settings';
import { parseJsonLoose, aiReady, aiAuthHeaders } from '../utils/ai';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const SIGNAL_SYSTEM = [
  'You are the signal engine of a trading terminal. You receive live stats for ONE instrument',
  '(price, RSI, 1-minute momentum, spread, volatility, ATR, and the last 10 candles of the requested timeframe)',
  'and must output ONE actionable signal on that instrument.',
  'Respond with ONLY a JSON object, no markdown and no prose, shaped:',
  '{"side":"LONG|SHORT|WAIT","confidence":0-100,"slPips":12.5,"tpPips":22,',
  '"reasons":["max 3 short reasons citing the given stats"],"summary":"one sentence"}',
  'Rules: side LONG means buy, SHORT means sell. Use WAIT when the evidence conflicts or the spread/volatility makes the trade poor.',
  'slPips/tpPips are in pips: scale the stop from volatilityPips (roughly 1-2x) and target at least 1.3x the stop. For indices 1 pip = 1 point.',
  'Confidence reflects how strongly the evidence supports the side; a WAIT signal gets low confidence.',
  'Never invent figures that are not derivable from the given stats.',
].join(' ');

function signalContext(s, tf) {
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
    recentBars: engine.getCandles(s.symbol, tf).slice(-10).map((c) => ({
      o: c.open, h: c.high, l: c.low, c: c.close,
    })),
  };
}

async function callSignalModel(settings, payload) {
  const res = await fetch(`${settings.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
    body: JSON.stringify({
      model: settings.aiModel || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SIGNAL_SYSTEM },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI model responded ${res.status}`);
  const data = await res.json();
  const parsed = parseJsonLoose(data.choices?.[0]?.message?.content ?? '');
  if (!parsed) throw new Error('Could not parse the model response.');
  return parsed;
}

// Clamp anything the model returns into an engine-valid signal.
export function normalizeSignal(raw, s, tf) {
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
  const tpPips = clamp(num(raw?.tpPips) ?? slPips * 1.75, slPips * 1.1, slPips * 6);
  const dir = side === 'LONG' ? 1 : -1;
  const entry = s.mid;
  return {
    ...base,
    entry,
    slPips: +slPips.toFixed(1),
    tpPips: +tpPips.toFixed(1),
    sl: entry - dir * slPips * s.pip,
    tp: entry + dir * tpPips * s.pip,
    rr: +(tpPips / slPips).toFixed(2),
  };
}

export async function generateAiSignal(symbol, tf, strategy) {
  const s = engine.getState(symbol);
  if (!s) return null;
  const settings = loadSettings();
  const d = engine.getDetail(s);
  const fallback = {
    symbol,
    tf,
    side: d.side,
    entry: d.entry,
    sl: d.sl,
    tp: d.tp,
    rr: +d.rr.toFixed(2),
    slPips: +d.slPips.toFixed(1),
    tpPips: +d.tpPips.toFixed(1),
    confidence: s.confidence,
    reasons: d.reasons.slice(0, 4),
    summary: 'Engine-derived signal from live RSI, momentum, spread and session liquidity.',
    decimals: s.decimals,
    simulated: true,
  };
  if (!aiReady(settings)) return fallback;
  try {
    const payload = { instrument: signalContext(s, tf) };
    if (strategy) payload.strategy = strategy;
    const raw = await callSignalModel(settings, payload);
    return { ...normalizeSignal(raw, s, tf), simulated: false };
  } catch (err) {
    return { ...fallback, aiError: String(err?.message ?? err) };
  }
}
