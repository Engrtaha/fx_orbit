// Timeframe + window picking for per-trade detail charts.

export function pickTf(ageMs) {
  const h = ageMs / 3600000;
  if (h <= 4) return '1m';
  if (h <= 24) return '5m';
  if (h <= 70) return '15m';
  return '4H';
}

export function sliceWindow(candles, fromSec, toSec, padBars = 16) {
  if (!candles.length) return [];
  const step = candles.length > 1 ? candles[1].time - candles[0].time : 60;
  const lo = fromSec - padBars * step;
  const hi = toSec + padBars * step;
  let first = -1;
  let last = -1;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].time;
    if (t < lo || t > hi) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first !== -1) return candles.slice(first, last + 1);
  return candles.slice(-Math.max(padBars * 2, 40));
}

export function nearestTime(bars, t) {
  let best = bars[0].time;
  for (const c of bars) {
    if (Math.abs(c.time - t) < Math.abs(best - t)) best = c.time;
  }
  return best;
}
