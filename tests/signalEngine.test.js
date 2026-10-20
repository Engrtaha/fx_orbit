import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedStorage } from './setup.js';

// Seed before importing: the engine constructor and loadSettings read localStorage.
seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
const { engine } = await import('../src/data/marketEngine.js');
const mod = await import('../src/data/signalEngine.js');

engine.start();
clearInterval(engine.timer);
engine.timer = null; // keep prices frozen so assertions stay deterministic

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

const sigResult = (symbol, side, entry, slPips, tpPips) => {
  const s = engine.getState(symbol);
  const dir = side === 'LONG' ? 1 : -1;
  return {
    symbol, tf: '15m', side, entry,
    sl: entry - dir * slPips * s.pip,
    tp: entry + dir * tpPips * s.pip,
    slPips, tpPips,
    rr: +(tpPips / slPips).toFixed(2),
    confidence: 60,
    summary: 'test signal',
    decimals: s.decimals,
  };
};

describe('normalizeSignal', () => {
  it('builds a LONG signal and lifts a thin target to the 2R minimum', () => {
    const out = mod.normalizeSignal({ side: 'LONG', confidence: 72, slPips: 24, tpPips: 40, reasons: ['RSI 58 bullish', 'momentum rising'], summary: 'Momentum supports longs.' }, makeState(), '15m');
    expect(out.side).toBe('LONG');
    expect(out.confidence).toBe(72);
    expect(out.slPips).toBe(24);
    expect(out.tpPips).toBe(48); // 40 was only 1.67R — lifted to the floor
    expect(out.rr).toBeCloseTo(2, 2);
    expect(out.sl).toBeCloseTo(1.085 - 24 * pip, 5);
    expect(out.tp).toBeCloseTo(1.085 + 48 * pip, 5);
  });

  it('defaults the target to 2.5x the stop when the model omits it', () => {
    const out = mod.normalizeSignal({ side: 'LONG', slPips: 20 }, makeState(), '15m');
    expect(out.tpPips).toBeCloseTo(50, 1);
    expect(out.rr).toBeCloseTo(2.5, 2);
  });

  it('mirrors direction for SHORT — sl above entry, tp below', () => {
    const out = mod.normalizeSignal({ side: 'SHORT', slPips: 30, tpPips: 75 }, makeState(), '5m');
    expect(out.sl).toBeCloseTo(1.085 + 30 * pip, 5);
    expect(out.tp).toBeCloseTo(1.085 - 75 * pip, 5);
  });

  it('keeps WAIT as a levelless signal', () => {
    const out = mod.normalizeSignal({ side: 'WAIT', confidence: 30, slPips: 99, tpPips: 99 }, makeState(), '15m');
    expect(out.side).toBe('WAIT');
    expect(out.sl).toBeNull();
    expect(out.tp).toBeNull();
    expect(out.rr).toBeNull();
  });

  it('falls back to the engine score when the side is invalid', () => {
    expect(mod.normalizeSignal({ side: 'buy' }, makeState({ score: 2 }), '15m').side).toBe('LONG');
    expect(mod.normalizeSignal({}, makeState({ score: -2 }), '15m').side).toBe('SHORT');
    expect(mod.normalizeSignal({}, makeState({ score: 0 }), '15m').side).toBe('WAIT');
  });

  it('clamps stops and targets to the instrument volatility', () => {
    const out = mod.normalizeSignal({ side: 'LONG', slPips: 500, tpPips: 5 }, makeState(), '15m');
    expect(out.slPips).toBeLessThanOrEqual(20 * 3.5);
    expect(out.tpPips).toBeGreaterThanOrEqual(out.slPips * 1.1);
  });

  it('clamps confidence and caps reasons at 3', () => {
    const out = mod.normalizeSignal({ side: 'LONG', confidence: 250, reasons: ['a', 'b', 'c', 'd', 'e'] }, makeState(), '15m');
    expect(out.confidence).toBe(99);
    expect(out.reasons).toHaveLength(3);
  });
});

describe('active signal lifecycle', () => {
  // The monitor does nothing while the tape is shut, so pin the clock to an
  // open window (Monday 16:00 UTC). Only Date is faked — timers stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T16:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stores tradable signals, one per symbol, and skips WAIT', () => {
    expect(mod.saveSignal({ side: 'WAIT', sl: null, tp: null, symbol: 'US100' }, 'ai')).toBeNull();

    const s = engine.getState('US100');
    const first = mod.saveSignal(sigResult('US100', 'LONG', s.mid, 1000, 1000), 'ai');
    const again = mod.saveSignal(sigResult('US100', 'SHORT', s.mid, 1000, 1000), 'my');
    mod.saveSignal(sigResult('XAU/USD', 'LONG', engine.getState('XAU/USD').mid, 1000, 1000), 'ai');

    expect(mod.activeSignals()).toHaveLength(2);
    expect(mod.activeSignalFor('US100').id).toBe(again.id);
    expect(mod.activeSignalFor('US100').id).not.toBe(first.id);
    expect(mod.activeSignalFor('US100').side).toBe('SHORT');
    expect(mod.activeSignalFor('US100').mode).toBe('my');
    expect(JSON.parse(localStorage.getItem('fxorbit-signals')).active).toHaveLength(2);
  });

  it('keeps a signal open while price stays between SL and TP', async () => {
    const before = mod.activeSignals().length;
    await mod.tickSignals();
    expect(mod.activeSignals()).toHaveLength(before);
    expect(mod.recentOutcomes(10).filter((o) => o.symbol === 'US100')).toHaveLength(0);
  });

  it('closes a LONG at TP, records the outcome and regenerates the next signal', async () => {
    const st = engine.getState('XAU/USD');
    st.score = 2; // deterministic LONG for the engine-fallback regeneration
    const plan = sigResult('XAU/USD', 'LONG', st.mid, 50, 80);
    const oldId = mod.saveSignal(plan, 'ai').id;

    st.mid = plan.tp + 10 * st.pip; // gap through take profit
    await mod.tickSignals();

    const hit = mod.recentOutcomes(10).find((o) => o.symbol === 'XAU/USD' && o.status === 'tp');
    expect(hit).toBeDefined();
    expect(hit.pips).toBe(80);
    expect(hit.exitPrice).toBeCloseTo(plan.tp + 10 * st.pip, 6);

    const next = mod.activeSignalFor('XAU/USD');
    expect(next).not.toBeNull();
    expect(next.id).not.toBe(oldId);
    expect(next.entry).toBeCloseTo(st.mid, 6);
  });

  it('closes a SHORT at SL and books the loss', async () => {
    const st = engine.getState('EUR/USD');
    st.score = -2; // deterministic SHORT for the regeneration
    const plan = sigResult('EUR/USD', 'SHORT', st.mid, 40, 60);
    mod.saveSignal(plan, 'ai');

    st.mid = plan.sl + 10 * st.pip; // gap through the stop
    await mod.tickSignals();

    const hit = mod.recentOutcomes(10).find((o) => o.symbol === 'EUR/USD' && o.status === 'sl');
    expect(hit).toBeDefined();
    expect(hit.pips).toBe(-40);
    expect(mod.activeSignalFor('EUR/USD')).not.toBeNull();
  });

  it('holds signals untouched while the market is closed', async () => {
    vi.setSystemTime(new Date('2026-10-10T16:00:00Z')); // Saturday afternoon
    const st = engine.getState('US100');
    const plan = mod.saveSignal(sigResult('US100', 'LONG', st.mid, 50, 80), 'ai');
    st.mid = plan.tp + 10 * st.pip; // would have scored a TP hit on a live tape

    await mod.tickSignals();

    expect(mod.activeSignalFor('US100').id).toBe(plan.id);
    expect(mod.recentOutcomes(10).find((o) => o.symbol === 'US100')).toBeUndefined();
  });

  it('reports live pips and the entry-to-target fraction', () => {
    const st = engine.getState('US100');
    const entry = st.mid;
    mod.saveSignal(sigResult('US100', 'LONG', entry, 20, 20), 'ai');
    st.mid = entry + 10 * st.pip; // halfway to target

    const prog = mod.signalProgress(mod.activeSignalFor('US100'));
    expect(prog.pips).toBeCloseTo(10, 1);
    expect(prog.frac).toBeCloseTo(0.5, 5);

    st.mid = entry; // restore so later ticks stay between levels
  });
});

describe('strategy reward:risk', () => {
  it('reads the R:R a strategy writes in its own rules', async () => {
    const { strategyRewardRisk, rrLabel } = await import('../src/utils/riskReward.js');
    expect(strategyRewardRisk('Take profit at 1:4.5 risk to reward')).toBe(4.5);
    expect(strategyRewardRisk('Target 4.5R from the sweep wick')).toBe(4.5);
    expect(strategyRewardRisk('R:R 1:3 minimum')).toBe(3);
    expect(strategyRewardRisk('Use a risk-reward ratio of 3')).toBe(3);
    expect(strategyRewardRisk('Move SL to break-even at 1:1 R, final target 1:4.5')).toBe(4.5);
    expect(strategyRewardRisk({ riskRules: ['Stop beyond the wick', 'TP 1 : 4.5'] })).toBe(4.5);
    expect(strategyRewardRisk({ name: 'X', rules: 'Risk 0.5–1% of equity per trade; daily loss cap of 3%' })).toBeNull();
    expect(strategyRewardRisk('Exit the target at 11:30 London time')).toBeNull();
    expect(strategyRewardRisk('Take profit at 2.4× ATR(14)')).toBeNull();
    expect(strategyRewardRisk('')).toBeNull();
    expect(rrLabel(4.5)).toBe('1:4.5');
    expect(rrLabel(2.5)).toBe('1:2.5');
  });

  it('sizes a model target from the strategy R:R, not the 2.5 default', () => {
    const out = mod.normalizeSignal({ side: 'LONG', slPips: 20, tpPips: 50 }, makeState(), '15m', { rr: 4.5 });
    expect(out.tpPips).toBeCloseTo(90, 1);
    expect(out.rr).toBe(4.5);
  });

  it('builds the engine signal at the strategy R:R', async () => {
    seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
    const plain = await mod.generateAiSignal('XAU/USD', '15m', null);
    expect(plain.simulated).toBe(true);
    if (plain.side !== 'WAIT') expect(plain.rr).toBeCloseTo(mod.DEFAULT_RR, 1);
    const booked = await mod.generateAiSignal('XAU/USD', '15m', { name: 'Sweep', rules: 'TP at 1:4.5 risk to reward' });
    if (booked.side !== 'WAIT') {
      expect(booked.rr).toBeCloseTo(4.5, 2);
      expect(booked.tpPips / booked.slPips).toBeCloseTo(4.5, 1);
    }
  });
});

describe('reversal signals', () => {
  const plantSweep = (symbol, tf) => {
    const s = engine.getState(symbol);
    const bars = engine.getCandles(symbol, tf);
    const p = s.mid;
    const step = bars[1].time - bars[0].time;
    const t0 = bars[bars.length - 1].time;
    bars.length = 0;
    // A quiet range, then a bar that runs the range high and closes back inside,
    // then the bar now forming.
    for (let i = 0; i < 30; i++) {
      bars.push({ time: t0 - (31 - i) * step, open: p * 0.9998, high: p * 1.001, low: p * 0.998, close: p * 1.0002, volume: 100 });
    }
    bars.push({ time: t0 - step, open: p * 1.0008, high: p * 1.004, low: p * 0.9992, close: p * 0.9995, volume: 300 });
    bars.push({ time: t0, open: p * 0.9995, high: p * 0.9998, low: p * 0.9993, close: p * 0.9996, volume: 50 });
    return s;
  };

  it('signals SHORT on a swept high, with the stop beyond the sweep', async () => {
    seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
    const s = plantSweep('XAU/USD', '5m');
    s.score = 3; // momentum alone would say LONG — the reversal must win
    const sig = await mod.generateAiSignal('XAU/USD', '5m', null);
    expect(sig.side).toBe('SHORT');
    expect(sig.reversal).toMatchObject({ side: 'SHORT', kind: 'sweep' });
    expect(sig.sl).toBeGreaterThan(s.mid * 1.004); // beyond the swept extreme
    expect(sig.tp).toBeLessThan(sig.entry);
    expect(sig.reasons[0]).toContain('reversal');
  });

  it('lets a pure trend book keep its side but still reports the reversal', async () => {
    const s = plantSweep('XAU/USD', '1H');
    s.score = 3;
    const sig = await mod.generateAiSignal('XAU/USD', '1H', { name: 'EMA trend', rules: 'Trade with the 21 EMA trend, buy pullbacks' });
    expect(sig.reversal?.side).toBe('SHORT');
    expect(sig.side).toBe(engine.getDetail(s).side);
  });

  it('keeps the reversal on the stored signal for the badge', () => {
    const sig = mod.saveSignal({ ...sigResult('XAU/USD', 'SHORT', 2400, 20, 90), reversal: { side: 'SHORT', kind: 'sweep', label: 'x' } });
    expect(sig.reversal).toMatchObject({ side: 'SHORT' });
  });
});

describe('explicit strategy fields on signals', () => {
  it('uses the book\'s rr field over its text and the default', async () => {
    seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
    const sig = await mod.generateAiSignal('EUR/USD', '15m', { name: 'B', rules: 'TP at 1:2 risk to reward', rr: 3.5 });
    if (sig.side !== 'WAIT') expect(sig.rr).toBeCloseTo(3.5, 2);
  });

  it('acts on a reversal only for a reversal setup', () => {
    expect(mod.actsOnReversal({ name: 'x', rules: 'Fade the sweep', setup: 'trend' })).toBe(false);
    expect(mod.actsOnReversal({ name: 'x', rules: 'Buy the EMA cross', setup: 'reversal' })).toBe(true);
    expect(mod.actsOnReversal(null)).toBe(true); // AI Best — no book
  });
});

describe('signal expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T16:00:00Z')); // Monday, tape open
  });
  afterEach(() => vi.useRealTimers());

  it('lives for the book\'s hold time, else 16 bars of its timeframe', () => {
    expect(mod.signalLifetimeMs({ tf: '15m' })).toBe(4 * 3600e3);
    expect(mod.signalLifetimeMs({ tf: '1H' })).toBe(16 * 3600e3);
    expect(mod.signalLifetimeMs({ tf: '15m', strategyRules: { rules: '', holdHours: 2 } })).toBe(2 * 3600e3);
    expect(mod.signalLifetimeMs({ tf: '15m', strategyRules: 'Time-stop: exit after 6 hours' })).toBe(6 * 3600e3);
  });

  it('closes a stale signal as expired at the live price, then regenerates', async () => {
    const s = engine.getState('EUR/USD');
    const sig = mod.saveSignal(sigResult('EUR/USD', 'LONG', s.mid, 1000, 1000), 'ai');
    expect(sig.expiresAt).toBe(sig.createdAt + 4 * 3600e3);
    await mod.tickSignals();
    expect(mod.activeSignalFor('EUR/USD')?.id).toBe(sig.id); // not yet

    vi.setSystemTime(new Date(Date.parse('2026-10-12T16:00:00Z') + 4 * 3600e3 + 1000));
    const pip = engine.pipFor('EUR/USD');
    s.mid = sig.entry + 7 * pip; // between SL and TP
    await mod.tickSignals();
    const out = mod.recentOutcomes(20).find((o) => o.id === sig.id);
    expect(out.status).toBe('expired');
    expect(out.pips).toBeCloseTo(7, 1); // booked at the live price, not at a level
    expect(mod.activeSignalFor('EUR/USD')?.id).not.toBe(sig.id);
  });
});
