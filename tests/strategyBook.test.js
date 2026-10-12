import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({
  pairs: ['US100', 'XAU/USD'],
  defaultPair: 'US100',
  activeStrategy: 'Legacy Dip Book',
  activeStrategyData: { title: 'Legacy Dip Book', pair: 'US100', analysis: 'one paragraph', entryRules: ['buy dips'], riskRules: ['1.4x ATR stop'] },
});
const book = await import('../src/data/strategyBook.js');
const { loadStrategies } = await import('../src/data/settings.js');

const seed = (over = {}) => book.normalizeStrategy({
  title: 'Alpha Book', pair: 'US100',
  analysis: ['reads momentum'], entryRules: ['EMA-9 cross up'], riskRules: ['stop 1.4x ATR'],
  ...over,
});

describe('normalizeStrategy', () => {
  it('gives every entry an id, a shape and timestamps', () => {
    const s = seed();
    expect(s.id).toMatch(/^s-/);
    expect(s.origin).toBe('manual');
    expect(s.armed).toBe(false);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.parents).toEqual([]);
  });

  it('coerces loose model output into clean string lists', () => {
    const s = book.normalizeStrategy({ title: ' X ', analysis: 'one block', entryRules: [' a ', '', 5], riskRules: null });
    expect(s.title).toBe('X');
    expect(s.analysis).toEqual(['one block']);
    expect(s.entryRules).toEqual(['a', '5']);
    expect(s.riskRules).toEqual([]);
  });

  it('rejects an unknown origin instead of inventing one', () => {
    expect(book.normalizeStrategy({ title: 'T', origin: 'vibes' }).origin).toBe('manual');
  });
});

describe('loadLibrary', () => {
  it('imports the pre-library active strategy exactly once', () => {
    const first = book.loadLibrary();
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe('Legacy Dip Book');
    expect(loadStrategies()).toHaveLength(1);
    expect(book.loadLibrary()).toHaveLength(1);
  });
});

describe('library edits', () => {
  it('adds to the front and never duplicates an id', () => {
    const a = seed({ id: 'a' });
    const b = seed({ id: 'b', title: 'Beta Book' });
    const list = book.addStrategy(book.addStrategy([], a), b);
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(book.addStrategy(list, { ...a, title: 'renamed' })).toHaveLength(2);
  });

  it('updates in place, keeping the original creation time', () => {
    const created = Date.now() - 5000;
    const list = [seed({ id: 'a', createdAt: created, updatedAt: created })];
    const [out] = book.updateStrategy(list, 'a', { title: 'Alpha Renamed', entryRules: ['new rule'] });
    expect(out.title).toBe('Alpha Renamed');
    expect(out.entryRules).toEqual(['new rule']);
    expect(out.createdAt).toBe(created);
    expect(out.updatedAt).toBeGreaterThanOrEqual(created);
  });

  it('removes one strategy and leaves its siblings alone', () => {
    const list = [seed({ id: 'a' }), seed({ id: 'b' })];
    expect(book.removeStrategy(list, 'a').map((s) => s.id)).toEqual(['b']);
  });

  it('arms only the targeted strategy', () => {
    const list = [seed({ id: 'a' }), seed({ id: 'b' })];
    const armed = book.armStrategy(list, 'a', true);
    expect(armed.find((s) => s.id === 'a').armed).toBe(true);
    expect(armed.find((s) => s.id === 'b').armed).toBe(false);
  });
});

describe('mergeStrategies', () => {
  it('unions the rules and records both parents', () => {
    const a = seed({ id: 'a', title: 'Dip Hunter Strategy', pair: 'US100', entryRules: ['shared rule', 'a only'] });
    const b = seed({ id: 'b', title: 'Breakout Rider Strategy', pair: 'US100', entryRules: ['shared rule', 'b only'], riskRules: ['daily loss cap 3%'] });
    const merged = book.mergeStrategies(a, b);
    expect(merged.origin).toBe('merged');
    expect(merged.parents).toEqual(['a', 'b']);
    expect(merged.title).toBe('Dip Hunter × Breakout Rider Merge');
    expect(merged.pair).toBe('US100');
    expect(merged.entryRules).toEqual(['shared rule', 'a only', 'b only']);
    expect(merged.riskRules).toContain('daily loss cap 3%');
  });

  it('caps the merged rule lists and flags a pair disagreement', () => {
    const many = (p) => Array.from({ length: 9 }, (_, i) => `${p}${i}`);
    const merged = book.mergeStrategies(
      seed({ id: 'a', pair: 'US100', entryRules: many('a') }),
      seed({ id: 'b', pair: 'XAU/USD', entryRules: many('b') }),
    );
    expect(merged.entryRules).toHaveLength(8);
    expect(merged.analysis.join(' ')).toContain('different pairs');
  });
});

describe('strategy timeframes', () => {
  const dipHunter = {
    title: 'Dip Hunter Strategy',
    pair: 'XAU/USD',
    analysis: [
      'Waiting for a candlestick pattern on the one-minute chart, watching the trend '
      + 'on the four-hour chart and switching to the five-minute chart for the FVG inversion.',
    ],
    entryRules: [
      'Low of previous 1-minute candle is broken',
      'Green candle on one-minute chart',
      'Inversion of FVG indicator on five-minute chart',
    ],
    riskRules: ['Stop loss above high of previous day'],
  };

  it('reads the traded timeframes out of the rules themselves', () => {
    expect(book.detectTimeframes(dipHunter)).toEqual(['1m', '5m']);
  });

  it('skips a higher-timeframe filter that only lives in the analysis prose', () => {
    expect(book.detectTimeframes({ ...dipHunter, analysis: ['watch the four-hour chart for trend'] })).toEqual(['1m', '5m']);
    expect(book.detectTimeframes({ ...dipHunter, entryRules: [...dipHunter.entryRules, 'watch the four-hour chart for trend'] })).toEqual(['1m', '5m', '4H']);
  });

  it('does not mistake risk-rule durations for timeframes', () => {
    const s = { title: 'Momentum', entryRules: ['exit after 4 hours of stagnation'], riskRules: ['daily loss cap of 3%'] };
    expect(book.detectTimeframes(s)).toBeNull();
  });

  it('needs a chart context word in the rule before counting a timeframe', () => {
    expect(book.detectTimeframes({ title: 'Scalper', entryRules: ['enter on 5m'] })).toBeNull();
    expect(book.detectTimeframes({ title: 'Scalper', entryRules: ['enter on the 5m bar'] })).toEqual(['5m']);
  });

  it('counts a timeframe named in the title without any context word', () => {
    expect(book.detectTimeframes({ title: '15m Momentum Rider', entryRules: ['EMA cross'] })).toEqual(['15m']);
  });

  it('stores the detection on normalize and lets an explicit list win', () => {
    expect(book.normalizeStrategy(dipHunter).timeframes).toEqual(['1m', '5m']);
    expect(book.normalizeStrategy({ ...dipHunter, timeframes: ['5m'] }).timeframes).toEqual(['5m']);
    expect(book.normalizeStrategy({ ...dipHunter, timeframes: [] }).timeframes).toEqual([]);
    expect(book.normalizeStrategy({ title: 'T', timeframes: ['5m', '2h', 'nope'] }).timeframes).toEqual(['5m']);
  });

  it('allowedTimeframes always returns a usable, ordered list', () => {
    expect(book.allowedTimeframes(null)).toEqual(['1m', '5m', '15m', '1H', '4H', '1D']);
    expect(book.allowedTimeframes({})).toEqual(['1m', '5m', '15m', '1H', '4H', '1D']);
    expect(book.allowedTimeframes({ timeframes: [] })).toEqual(['1m', '5m', '15m', '1H', '4H', '1D']);
    expect(book.allowedTimeframes(dipHunter)).toEqual(['1m', '5m']);
    expect(book.allowedTimeframes({ ...dipHunter, timeframes: ['1m'] })).toEqual(['1m']);
  });

  it('formats a timeframe list the way the pages say it', () => {
    expect(book.timeframeLabel(['1m'])).toBe('1m');
    expect(book.timeframeLabel(['1m', '5m'])).toBe('1m and 5m');
    expect(book.timeframeLabel(['1m', '5m', '15m'])).toBe('1m, 5m and 15m');
  });

  it('merges the union of restricted parents, and stays open when either is', () => {
    const a = seed({ id: 'a', entryRules: ['enter on the 1m candle'] });
    const b = seed({ id: 'b', entryRules: ['enter on the 15m candle'] });
    const open = seed({ id: 'c' });
    expect(book.mergeStrategies(a, b).timeframes).toEqual(['1m', '15m']);
    expect(book.mergeStrategies(a, open).timeframes).toEqual([]);
  });
});

describe('applyActive', () => {
  it('mirrors the chosen strategy into settings for the other pages', () => {
    const list = [seed({ id: 'a', title: 'Chosen Book' })];
    const active = book.applyActive(list, 'a');
    expect(active.id).toBe('a');
    const s = JSON.parse(localStorage.getItem('fxorbit-settings'));
    expect(s.activeStrategyId).toBe('a');
    expect(s.activeStrategy).toBe('Chosen Book');
    expect(s.activeStrategyData.entryRules).toEqual(['EMA-9 cross up']);
  });

  it('clears the mirror when nothing is active', () => {
    book.applyActive([seed({ id: 'a' })], 'a');
    expect(book.applyActive([seed({ id: 'a' })], '')).toBeNull();
    const s = JSON.parse(localStorage.getItem('fxorbit-settings'));
    expect(s.activeStrategy).toBe('');
    expect(s.activeStrategyData).toBeNull();
  });
});
