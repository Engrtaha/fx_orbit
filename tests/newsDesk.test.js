import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

// Seed before importing: the engine constructor and loadSettings read localStorage.
seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
const { engine } = await import('../src/data/marketEngine.js');
const mod = await import('../src/data/newsEngine.js');

engine.start();
clearInterval(engine.timer);
engine.timer = null; // keep prices frozen so assertions stay deterministic
engine.markAllTv(true); // the desk only places trades on a live feed

const now = () => Math.floor(Date.now() / 1000);
const headline = (over = {}) => ({
  id: `n-${Math.random().toString(36).slice(2, 8)}`,
  feed: 'news', kind: 'news', time: now() - 600,
  title: 'Swiss Franc: Range trading persists against the US Dollar',
  summary: 'The bank notes the pair remains in a tight range around 0.8300.',
  impact: 'medium', ...over,
});

describe('universe scoping', () => {
  it('maps enabled pairs to their currency codes', () => {
    const ccys = mod.universeCurrencies();
    expect([...ccys].sort()).toEqual(['EUR', 'USD', 'XAU']);
    expect([...mod.universeCurrencies(['JP225', 'XAG/USD'])].sort()).toEqual(['JPY', 'USD', 'XAG']);
  });

  it('keeps calendar items by currency and headlines by tagged currencies', () => {
    const ccys = mod.universeCurrencies();
    expect(mod.itemInUniverse({ feed: 'calendar', currency: 'USD' }, ccys)).toBe(true);
    expect(mod.itemInUniverse({ feed: 'calendar', currency: 'JPY' }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news', currencies: ['CAD'] }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news', currencies: ['XAU'] }, ccys)).toBe(true);
  });

  it('hides untagged headlines while scoped, shows everything unscoped', () => {
    const ccys = mod.universeCurrencies();
    expect(mod.itemInUniverse({ feed: 'news' }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news' }, new Set())).toBe(true);
  });
});

describe('desk heuristic (via analyzeItem)', () => {
  it('sells a bearish headline on the default pair with a coherent plan', async () => {
    const a = await mod.analyzeItem(headline({
      title: 'Canadian Dollar falls to near 18-month lows as oil prices decline',
      summary: 'The loonie slid for a third session.',
    }));
    expect(a.impact).toBe('medium');
    expect(a.sentiment).toBe('bearish');
    expect(a.trade).not.toBeNull();
    expect(a.trade.side).toBe('SELL');
    expect(a.trade.symbol).toBe('US100');
    expect(a.trade.sl).toBeGreaterThan(a.trade.entry);
    expect(a.trade.tp).toBeLessThan(a.trade.entry);
    expect(a.trade.rr).toBeCloseTo(a.trade.tpPips / a.trade.slPips, 2);
    expect(a.simulated).toBe(true);
  });

  it('does not treat "against" as the GAIN keyword (word boundaries)', async () => {
    const a = await mod.analyzeItem(headline());
    expect(a.sentiment).toBe('neutral');
    expect(a.trade).toBeNull();
    expect(a.summary).toContain('stands aside');
  });

  it('stands aside on low-impact items even with strong wording', async () => {
    const a = await mod.analyzeItem(headline({
      impact: 'low',
      title: 'Gold surges to a record high as demand explodes',
    }));
    expect(a.impact).toBe('low');
    expect(a.trade).toBeNull();
    expect(a.summary).toContain('tradable threshold');
  });

  it('uses a shorter horizon for high-impact reads', async () => {
    const a = await mod.analyzeItem(headline({
      impact: 'high',
      title: 'Dollar tumbles as traders price deeper rate cuts',
    }));
    expect(a.sentiment).toBe('bearish');
    expect(a.trade.side).toBe('SELL');
    expect(a.read).toEqual({ symbol: 'US100', direction: 'bearish' });
    expect(a.trade.horizon).toBe('hours');
  });

  it('maps a USD-calendar beat through quote direction — hot CPI is bearish US100', async () => {
    const a = await mod.analyzeItem({
      id: 'cal-1', feed: 'calendar', kind: 'calendar', time: now() - 60,
      title: 'CPI y/y', currency: 'USD', impact: 'high',
      actual: 3.4, estimate: 3.1, previous: 3.0, unit: '%',
    });
    expect(a.currencies).toContain('USD');
    expect(a.sentiment).toBe('bullish');
    expect(a.read).toEqual({ symbol: 'US100', direction: 'bearish' });
    expect(a.trade.side).toBe('SELL');
    expect(a.trade.sl).toBeGreaterThan(a.trade.tp);
    expect(a.summary).toContain('above consensus');
    expect(a.summary).toContain('BEARISH for US100');
  });

  it('waits on an event with no numbers and no directional tone', async () => {
    const a = await mod.analyzeItem({
      id: 'cal-2', feed: 'calendar', kind: 'calendar', time: now() + 3600,
      title: 'FOMC Member Waller Speaks', currency: 'USD', impact: 'medium',
    });
    expect(a.trade).toBeNull();
    expect(a.sentiment).toBe('neutral');
  });
});

describe('pair direction (quote-currency mapping)', () => {
  it('flips the tone when it is about the quote currency', () => {
    const item = { currencies: ['USD'] };
    expect(mod.pairDirectionOf('bearish', item, 'XAU/USD')).toEqual({ symbol: 'XAU/USD', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'EUR/USD')).toEqual({ symbol: 'EUR/USD', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'US100')).toEqual({ symbol: 'US100', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'USD/JPY')).toEqual({ symbol: 'USD/JPY', direction: 'bearish' });
    expect(mod.pairDirectionOf('bullish', item, 'XAU/USD').direction).toBe('bearish');
  });

  it('keeps the raw tone for base-currency or untagged items', () => {
    expect(mod.pairDirectionOf('bullish', { currencies: ['EUR'] }, 'EUR/USD').direction).toBe('bullish');
    expect(mod.pairDirectionOf('bearish', {}, 'XAU/USD').direction).toBe('bearish');
    expect(mod.pairDirectionOf('neutral', { currencies: ['USD'] }, 'XAU/USD').direction).toBe('neutral');
    expect(mod.pairDirectionOf('bullish', { currencies: ['USD'] }, null).direction).toBe('neutral');
  });
});

describe('desk trade book', () => {
  it('places, tracks and desk-closes a news trade', async () => {
    const item = headline({ title: 'Gold demand strong as buyers step in' });
    const plan = await mod.analyzeItem(item);
    expect(plan.trade.side).toBe('BUY');

    const t = mod.placeNewsTrade(plan.trade, item);
    expect(t.source).toBe('News AI');
    expect(t.status).toBe('open');
    expect(t.note).toContain('Gold demand strong');
    expect(mod.newsTrades().open).toHaveLength(1);

    expect(mod.closeNewsTrade(t.id)).toBe(true);
    expect(mod.closeNewsTrade(t.id)).toBe(false);
    const closed = mod.newsTrades().closed;
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('Desk Close');
  });

  it('flags high-impact news published after a trade that points the other way', async () => {
    const item = headline({ title: 'Gold demand strong as buyers step in' });
    const plan = await mod.analyzeItem(item);
    const t = mod.placeNewsTrade(plan.trade, item);

    const items = [
      { id: 'x1', feed: 'news', title: 'Risk appetite surges', time: now() + 10, currencies: ['USD'] },
      { id: 'x2', feed: 'news', title: 'Recession fears deepen', time: now() + 20, currencies: ['USD'] },
      { id: 'x3', feed: 'news', title: 'Recession fears deepen', time: now() - 900, currencies: ['USD'] },
      { id: 'x4', feed: 'news', title: 'Recession fears deepen', time: now() + 30, currencies: ['JPY'] },
    ];
    const analyses = {
      x1: { impact: 'high', sentiment: 'bullish' },
      x2: { impact: 'high', sentiment: 'bearish' },
      x3: { impact: 'high', sentiment: 'bearish' },
      x4: { impact: 'high', sentiment: 'bearish' },
    };
    const flags = mod.riskFlags(t, items, analyses);
    expect(flags.map((f) => f.itemId)).toEqual(['x2']);
  });
});
