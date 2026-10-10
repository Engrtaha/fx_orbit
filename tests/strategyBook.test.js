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
