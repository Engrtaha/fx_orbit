import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['US100', 'XAU/USD'], defaultPair: 'XAU/USD' });
const { engine, volatilityPips } = await import('../src/data/marketEngine.js');
const { UNIVERSE } = await import('../src/data/settings.js');

engine.start();
clearInterval(engine.timer);
engine.timer = null; // no background ticks — tests drive prices themselves

describe('engine universe', () => {
  it('instantiates only the enabled pairs while keeping the full universe', () => {
    expect(engine.getSnapshot().map((s) => s.symbol).sort()).toEqual(['US100', 'XAU/USD']);
    expect(engine.defs.size).toBe(UNIVERSE.length);
  });

  it('derives bid/ask around mid by the spread', () => {
    for (const s of engine.getSnapshot()) {
      expect(s.ask - s.bid).toBeCloseTo(s.spread * s.pip, 12);
      expect(s.changePct).toBeCloseTo(((s.mid - s.dayOpen) / s.dayOpen) * 100, 12);
    }
  });

  it('computes realised volatility from the 1m history', () => {
    for (const s of engine.getSnapshot()) {
      expect(volatilityPips(s)).toBeGreaterThan(0);
    }
  });

  it('applyUniverse swaps the live set and persists the selection', () => {
    engine.applyUniverse(['XAU/USD']);
    expect(engine.getSnapshot().map((s) => s.symbol)).toEqual(['XAU/USD']);
    expect(JSON.parse(localStorage.getItem('fxorbit-settings')).pairs).toEqual(['XAU/USD']);
    engine.applyUniverse(['US100', 'XAU/USD']);
    expect(engine.getSnapshot()).toHaveLength(2);
  });
});

describe('trade lifecycle', () => {
  it('opens a trade with entry at mid and stops sized in pips', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20, source: 'Test' });
    expect(t.status).toBe('open');
    expect(t.entry).toBe(s.mid);
    expect(t.sl).toBeCloseTo(s.mid - 10 * s.pip, 12);
    expect(t.tp).toBeCloseTo(s.mid + 20 * s.pip, 12);
    expect(engine.openTrade({ symbol: 'NOPE', side: 'BUY', slPips: 5, tpPips: 10 })).toBeNull();
    engine.closeTrade(t, s.mid, 'Manual cleanup');
  });

  it('closes BUY trades at take profit with pip accounting', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    s.mid = t.tp + s.pip;
    engine.checkTradeExits(s);
    expect(t.status).toBe('closed');
    expect(t.exitReason).toBe('TP Hit');
    expect(t.pips).toBe(20);
    expect(t.pnl).toBe(20);
  });

  it('closes SELL trades at stop loss with negative pips', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'SELL', slPips: 15, tpPips: 25 });
    expect(t.sl).toBeCloseTo(t.entry + 15 * s.pip, 12);
    s.mid = t.sl + s.pip;
    engine.checkTradeExits(s);
    expect(t.exitReason).toBe('SL Hit');
    expect(t.pips).toBe(-15);
  });

  it('time-stops trades that overstay', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    engine.tickCount = t.openTick + 241;
    engine.checkTradeExits(s);
    expect(t.exitReason).toBe('Time Stop');
  });

  it('ignores repeat closes and keeps stats consistent with the book', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    engine.closeTrade(t, s.mid + 3 * s.pip, 'Manual');
    const pipsBefore = t.pips;
    engine.closeTrade(t, s.mid, 'Manual again');
    expect(t.pips).toBe(pipsBefore);

    const closed = engine.getTrades().filter((x) => x.status === 'closed');
    const open = engine.getTrades().filter((x) => x.status === 'open');
    const stats = engine.tradeStats();
    expect(stats.closedCount).toBe(closed.length);
    expect(stats.openCount).toBe(open.length);
    expect(stats.netPnl).toBeCloseTo(+closed.reduce((a, x) => a + x.pnl, 0).toFixed(2), 2);
    const wins = closed.filter((x) => x.pnl > 0).length;
    expect(stats.winRate).toBe(Math.round((wins / closed.length) * 100));
  });
});
