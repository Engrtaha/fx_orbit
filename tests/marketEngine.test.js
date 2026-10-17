import { describe, expect, it, vi } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['US100', 'XAU/USD'], defaultPair: 'XAU/USD' });
const {
  engine, marketClosed, symbolMarketClosed, volatilityPips, TIMEFRAMES, barCloseIn, tfPeriodMs,
} = await import('../src/data/marketEngine.js');
const { UNIVERSE } = await import('../src/data/settings.js');

engine.start();
clearInterval(engine.timer);
engine.timer = null; // no background ticks — tests drive prices themselves
engine.markAllTv(true); // positions require a live feed; these tests stand in for it

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

  it('refuses to open a position while the feed is simulated', () => {
    const s = engine.getState('XAU/USD');
    engine.setTvLive('XAU/USD', false);
    expect(engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 })).toBeNull();

    engine.setTvLive('XAU/USD', true);
    const live = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    expect(live).not.toBeNull();
    engine.closeTrade(live, s.mid, 'Manual cleanup');
  });

  it('closes BUY trades at take profit with pip accounting', () => {
    const s = engine.getState('XAU/USD');
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    s.mid = t.tp + s.pip;
    engine.checkTradeExits(s);
    expect(t.status).toBe('closed');
    expect(t.exitReason).toBe('TP Hit');
    expect(t.pips).toBe(20);
    expect(t.pnl).toBeCloseTo(t.pips * (t.lots / 0.1), 6);
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

describe('risk-based position sizing', () => {
  const big = () => seedStorage({ pairs: ['US100', 'XAU/USD'], defaultPair: 'XAU/USD', initialBalance: 100000 });

  it('risks the same slice of equity whatever the stop width', () => {
    big();
    const eq = engine.accountEquity();
    for (const slPips of [25, 60, 237]) {
      const loss = (engine.riskLots(slPips) / 0.1) * slPips; // $ at a stop-out
      expect(Math.abs(loss - eq * 0.01) / (eq * 0.01)).toBeLessThan(0.02); // 0.01 rounding
    }
  });

  it('shrinks the position as the stop widens', () => {
    big();
    expect(engine.riskLots(237)).toBeLessThan(engine.riskLots(25));
  });

  it('opens the trade at the sized lot', () => {
    big();
    engine.setTvLive('XAU/USD', true);
    const t = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 40, tpPips: 80, source: 'Test' });
    expect(t.lots).toBe(engine.riskLots(40));
    engine.closeTrade(t, engine.getState('XAU/USD').mid, 'Manual cleanup');
  });

  it('never sizes below the smallest unit when the account is under water', () => {
    seedStorage({ pairs: ['US100', 'XAU/USD'], defaultPair: 'XAU/USD', initialBalance: -5000 });
    expect(engine.accountEquity()).toBeLessThan(0);
    expect(engine.riskLots(30)).toBe(0.01);
  });

  it('caps what a paper-thin stop would otherwise demand', () => {
    big();
    expect(engine.riskLots(1)).toBe(10);
  });

  it('treats a missing or nonsense stop as the smallest unit', () => {
    big();
    expect(engine.riskLots(0)).toBe(0.01);
    expect(engine.riskLots(undefined)).toBe(0.01);
  });
});

describe('PostgreSQL hydration', () => {
  it('starts with an empty book — no generated demo trades', () => {
    expect(engine.getTrades().every((t) => /^T-/.test(t.id))).toBe(true);
  });

  it('restores archived rows, re-arms open trades and keeps ids unique', () => {
    const n = engine.loadTrades([
      { id: 'T-120', symbol: 'XAU/USD', side: 'BUY', status: 'open', lots: 0.1, entry: 3000, sl: 2980, tp: 3050, openedAt: 1760000000000 },
      { id: 'T-121', symbol: 'XAU/USD', side: 'SELL', status: 'closed', lots: 0.1, entry: 3000, sl: 3020, tp: 2950, exit: 2950, pips: 50, pnl: 50, exitReason: 'TP Hit', openedAt: 1759999000000, closedAt: 1760000000000 },
      { id: 'bogus' }, // incomplete rows are ignored
    ]);
    expect(n).toBe(2);

    const restored = engine.getTrades().find((t) => t.id === 'T-120');
    expect(restored.openTick).toBe(engine.tickCount); // not instantly time-stopped
    expect(engine.tradeSeq).toBe(121);

    const fresh = engine.openTrade({ symbol: 'XAU/USD', side: 'BUY', slPips: 10, tpPips: 20 });
    expect(fresh.id).toBe('T-122');
    engine.closeTrade(fresh, engine.getState('XAU/USD').mid, 'cleanup');
    expect(engine.loadTrades([])).toBe(0); // nothing to restore leaves the book alone
  });
});

describe('weekend market hours', () => {
  const at = (iso) => marketClosed(new Date(iso));

  it('stays open through the week and until New York shuts on Friday', () => {
    expect(at('2026-10-09T13:00:00Z').closed).toBe(false); // Fri afternoon
    expect(at('2026-10-09T21:59:59Z').closed).toBe(false); // one second before the close
  });

  it('closes Friday 22:00 UTC and holds through Saturday', () => {
    const fri = at('2026-10-09T22:00:00Z');
    expect(fri.closed).toBe(true);
    expect(fri.reopensAt.toISOString()).toBe('2026-10-11T22:00:00.000Z');
    const sat = at('2026-10-10T16:00:00Z');
    expect(sat.closed).toBe(true);
    expect(sat.reopensAt.toISOString()).toBe('2026-10-11T22:00:00.000Z');
  });

  it('reopens Sunday 22:00 UTC for the Sydney session', () => {
    expect(at('2026-10-11T21:59:00Z').closed).toBe(true);
    expect(at('2026-10-11T22:00:00Z').closed).toBe(false);
    expect(at('2026-10-12T02:00:00Z').closed).toBe(false); // Mon 02:00
  });

  it('refuses to manage the trade book while the tape is shut', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T16:00:00Z'));
      expect(engine.bookOpenFor(engine.getState('XAU/USD'))).toBe(false);
      vi.setSystemTime(new Date('2026-10-12T16:00:00Z'));
      expect(engine.bookOpenFor(engine.getState('XAU/USD'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('crypto universe (24/7)', () => {
  it('lists crypto pairs in their own group with the alwaysOpen flag', () => {
    const crypto = UNIVERSE.filter((d) => d.group === 'Crypto');
    expect(crypto.length).toBeGreaterThanOrEqual(7);
    expect(crypto.map((d) => d.symbol)).toEqual(
      expect.arrayContaining(['BTC/USD', 'ETH/USD', 'SOL/USD', 'BNB/USD', 'XRP/USD', 'DOGE/USD', 'ADA/USD']),
    );
    expect(crypto.every((d) => d.alwaysOpen && d.pip > 0 && d.decimals > 0)).toBe(true);
  });

  it('keeps crypto open through the weekend while FX and indices stay shut', () => {
    const sat = new Date('2026-10-10T16:00:00Z');
    expect(symbolMarketClosed('BTC/USD', sat).closed).toBe(false);
    expect(symbolMarketClosed('ETH/USD', sat).closed).toBe(false);
    expect(symbolMarketClosed('EUR/USD', sat).closed).toBe(true);
    expect(symbolMarketClosed('US100', sat).closed).toBe(true);
  });

  it('opens and manages a crypto trade on a Saturday', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T16:00:00Z'));
      engine.applyUniverse(['BTC/USD']);
      engine.setTvLive('BTC/USD', true);
      const s = engine.getState('BTC/USD');
      expect(engine.bookOpenFor(s)).toBe(true);
      const t = engine.openTrade({ symbol: 'BTC/USD', side: 'BUY', slPips: 150, tpPips: 400 });
      expect(t).not.toBeNull();
      engine.closeTrade(t, s.mid, 'cleanup');
    } finally {
      vi.useRealTimers();
    }
    engine.applyUniverse(['US100', 'XAU/USD']);
  });
});

describe('bar close countdown', () => {
  it('gives every timeframe a period in milliseconds', () => {
    expect(TIMEFRAMES.map(tfPeriodMs)).toEqual([60000, 300000, 900000, 3600000, 14400000, 86400000]);
  });

  it('counts down to the epoch-aligned boundary the candles roll on', () => {
    expect(barCloseIn('1m', 75000)).toBe(45000);            // 15s into the minute
    expect(barCloseIn('5m', 340000)).toBe(260000);          // 40s into the 5m bar
    expect(barCloseIn('1D', Date.UTC(2026, 9, 12, 22, 0, 0))).toBe(7200000); // to midnight UTC
    expect(barCloseIn('4H', Date.UTC(2026, 9, 12, 5, 30, 0))).toBe(9000000); // to 08:00 UTC
  });

  it('hands a brand new bar the full period', () => {
    expect(barCloseIn('15m', 900000)).toBe(900000);
    expect(barCloseIn('1m', 0)).toBe(60000);
  });
});
