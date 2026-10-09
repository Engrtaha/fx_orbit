import { describe, expect, it } from 'vitest';
import { normalizeSignal } from '../src/data/signalEngine';

const pip = 0.0001;
const makeState = (over = {}) => ({
  symbol: 'EUR/USD',
  mid: 1.085,
  pip,
  decimals: 5,
  score: 2,
  confidence: 61,
  rsi: 58.4,
  momentum: 0.021,
  spread: 0.8,
  changePct: 0.12,
  candlesByTf: new Map([['1m', Array.from({ length: 20 }, () => ({ open: 1.085, high: 1.086, low: 1.084, close: 1.085 }))]]),
  ...over,
});
// 20 candles × (high-low)=0.002 → volatility = 20 pips per bar.

describe('normalizeSignal', () => {
  it('builds a LONG signal with engine-valid levels and rr', () => {
    const out = normalizeSignal({ side: 'LONG', confidence: 72, slPips: 24, tpPips: 40, reasons: ['RSI 58 bullish', 'momentum rising'], summary: 'Momentum supports longs.' }, makeState(), '15m');
    expect(out.side).toBe('LONG');
    expect(out.confidence).toBe(72);
    expect(out.slPips).toBe(24);
    expect(out.tpPips).toBe(40);
    expect(out.rr).toBeCloseTo(1.67, 1);
    expect(out.sl).toBeCloseTo(1.085 - 24 * pip, 5);
    expect(out.tp).toBeCloseTo(1.085 + 40 * pip, 5);
  });

  it('mirrors direction for SHORT — sl above entry, tp below', () => {
    const out = normalizeSignal({ side: 'SHORT', slPips: 30, tpPips: 45 }, makeState(), '5m');
    expect(out.sl).toBeCloseTo(1.085 + 30 * pip, 5);
    expect(out.tp).toBeCloseTo(1.085 - 45 * pip, 5);
  });

  it('keeps WAIT as a levelless signal', () => {
    const out = normalizeSignal({ side: 'WAIT', confidence: 30, slPips: 99, tpPips: 99 }, makeState(), '15m');
    expect(out.side).toBe('WAIT');
    expect(out.sl).toBeNull();
    expect(out.tp).toBeNull();
    expect(out.rr).toBeNull();
  });

  it('falls back to the engine score when the side is invalid', () => {
    expect(normalizeSignal({ side: 'buy' }, makeState({ score: 2 }), '15m').side).toBe('LONG');
    expect(normalizeSignal({}, makeState({ score: -2 }), '15m').side).toBe('SHORT');
    expect(normalizeSignal({}, makeState({ score: 0 }), '15m').side).toBe('WAIT');
  });

  it('clamps stops and targets to the instrument volatility', () => {
    const out = normalizeSignal({ side: 'LONG', slPips: 500, tpPips: 5 }, makeState(), '15m');
    expect(out.slPips).toBeLessThanOrEqual(20 * 3.5);
    expect(out.tpPips).toBeGreaterThanOrEqual(out.slPips * 1.1);
  });

  it('clamps confidence and caps reasons at 3', () => {
    const out = normalizeSignal({ side: 'LONG', confidence: 250, reasons: ['a', 'b', 'c', 'd', 'e'] }, makeState(), '15m');
    expect(out.confidence).toBe(99);
    expect(out.reasons).toHaveLength(3);
  });
});
