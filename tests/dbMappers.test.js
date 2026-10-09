import { describe, expect, it } from 'vitest';
import { newsRow } from '../server/db/news.js';
import { tradeRow, tradeShape } from '../server/db/tradeHistory.js';

// The mappers are pure, so the archive's column contract is testable without
// a running database.
describe('news row mapper', () => {
  it('writes an item in the declared column order', () => {
    const row = newsRow({
      id: 'FF:1760000000:CPI', kind: 'event', feed: 'calendar', time: 1760000000,
      title: 'CPI y/y', summary: '', url: null, source: 'ForexFactory',
      impact: 'high', sentiment: 'neutral', confidence: 80.4,
      currencies: ['USD'], topics: [], currency: 'USD',
      actual: 3.4, estimate: null, previous: '3.0', unit: '%',
    });
    expect(row).toHaveLength(18);
    expect(row[0]).toBe('FF:1760000000:CPI');
    expect(row[3]).toBe(1760000000);
    expect(row[5]).toBeNull(); // empty summary → NULL
    expect(row[10]).toBe(80); // confidence stored as an integer
    expect(row[11]).toEqual(['USD']);
    expect(row[14]).toBe('3.4'); // numeric actual coerced to text
    expect(row[15]).toBeNull();
  });

  it('drops missing ids and caps oversized currency/topic lists', () => {
    const row = newsRow({ id: null, time: null, title: 'x', currencies: new Array(80).fill('USD') });
    expect(row[0]).toBeNull();
    expect(row[3]).toBeNull();
    expect(row[11]).toHaveLength(32);
  });
});

describe('trade row mapper', () => {
  const trade = {
    id: 'T-007', symbol: 'US100', side: 'BUY', status: 'closed', source: 'News AI',
    strategyId: null, lots: 0.1, entry: 30000, sl: 29980, tp: 30050, exit: 30050,
    pips: 50, pnl: 50, exitReason: 'TP Hit', note: 'Gold demand strong',
    openedAt: 1760000000000, closedAt: 1760000001000,
  };

  it('maps the camelCase engine trade onto the 17 columns', () => {
    const row = tradeRow(trade);
    expect(row).toHaveLength(17);
    expect(row[0]).toBe('T-007');
    expect(row[4]).toBe('News AI');
    expect(row[15]).toBe(1760000000000); // opened_at as BIGINT
    expect(row[16]).toBe(1760000001000);
  });

  it('keeps an open trade closed_at as NULL rather than 0', () => {
    const row = tradeRow({ id: 'T-001', symbol: 'US100', side: 'BUY', status: 'open', entry: 30000, openedAt: 1760000000000, closedAt: null });
    expect(row[15]).toBe(1760000000000);
    expect(row[16]).toBeNull();
    expect(row[10]).toBeNull(); // no exit price yet
    expect(row[6]).toBeNull(); // lots unset stays NULL, not 0
  });

  it('reads a database row back into the engine shape, bigint-safe', () => {
    const back = tradeShape({
      id: 'T-007', symbol: 'US100', side: 'BUY', status: 'closed', source: 'News AI',
      strategy_id: null, lots: 0.1, entry: 30000, sl: 29980, tp: 30050, exit: 30050,
      pips: 50, pnl: 50, exit_reason: 'TP Hit', note: 'Gold demand strong',
      opened_at: '1760000000000', closed_at: '1760000001000', // int8 arrives as text
    });
    expect(back.openedAt).toBe(1760000000000);
    expect(back.closedAt).toBe(1760000001000);
    expect(back.exitReason).toBe('TP Hit');
    expect(back.strategyId).toBeNull();
    expect(back.openTick).toBeUndefined(); // recomputed by engine.loadTrades
  });
});
