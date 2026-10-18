import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['XAU/USD'], defaultPair: 'XAU/USD' });

// The book is read lazily on first use, so the stored record has to be in place
// before signalEngine is imported.
localStorage.setItem('fxorbit-signals', JSON.stringify({
  active: [
    { id: 'good', symbol: 'XAU/USD', side: 'LONG', entry: 3000, sl: 2990, tp: 3020, decimals: 2 },
    { id: 'no-levels', symbol: 'XAU/USD', side: 'LONG' },
    { id: 'wrong-side', symbol: 'XAU/USD', side: 'MAYBE', entry: 1, sl: 2, tp: 3, decimals: 2 },
    { id: 'nan-entry', symbol: 'XAU/USD', side: 'SHORT', entry: 'x', sl: 2, tp: 3, decimals: 2 },
    null,
  ],
  closed: [
    { symbol: 'XAU/USD', status: 'tp', pips: 20, closedAt: 1760000000000 },
    { symbol: 'XAU/USD', status: 'sideways', pips: 1, closedAt: 1760000000000 },
    { symbol: 'XAU/USD', status: 'sl', pips: null, closedAt: 1760000000000 },
    'junk',
  ],
}));

const { activeSignals, recentOutcomes } = await import('../src/data/signalEngine.js');

describe('signal book read back from localStorage', () => {
  it('keeps only a signal the hit monitor can actually score', () => {
    expect(activeSignals().map((s) => s.id)).toEqual(['good']);
  });

  it('keeps only outcomes the page can render', () => {
    const kept = recentOutcomes(10);
    expect(kept.length).toBe(1);
    expect(kept[0].status).toBe('tp');
    expect(typeof kept[0].pips).toBe('number');
    expect(() => kept[0].status.toUpperCase()).not.toThrow();
  });
});
