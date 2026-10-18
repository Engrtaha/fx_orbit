import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

// Seed before importing: settings.js reads localStorage at module level nowhere,
// but every page calls loadSettings() during its first render.
seedStorage({});
const { loadSettings, DEFAULT_ENABLED } = await import('../src/data/settings.js');

const store = (obj) => localStorage.setItem('fxorbit-settings', typeof obj === 'string' ? obj : JSON.stringify(obj));

describe('settings read back from localStorage', () => {
  it('falls back to the defaults when the record is not an object', () => {
    for (const raw of ['null', '"a string"', '[1,2]', '42', '{ not json']) {
      store(raw);
      expect(loadSettings().profileName).toBe('coder nice');
      expect(loadSettings().pairs.length).toBeGreaterThan(0);
    }
  });

  it('never lets a stored null override a value a page dereferences', () => {
    store({
      profileName: null, aiBaseUrl: null, tvBackendUrl: null, aiModel: null,
      riskPerTrade: null, tvEnabled: null, autoTrade: null, initialBalance: 'lots',
    });
    const s = loadSettings();
    expect(() => s.profileName.split(' ')).not.toThrow();
    expect(() => s.aiBaseUrl.replace(/\/$/, '')).not.toThrow();
    expect(() => s.tvBackendUrl.replace(/\/+$/, '')).not.toThrow();
    expect(typeof s.tvEnabled).toBe('boolean');
    expect(Array.isArray(s.autoTrade)).toBe(true);
    expect(Number.isFinite(s.riskPerTrade)).toBe(true);
    expect(Number.isFinite(s.initialBalance)).toBe(true);
  });

  it('keeps pairs a usable string array', () => {
    store({ pairs: 'EUR/USD' });
    expect(loadSettings().pairs).toEqual([...DEFAULT_ENABLED]);
    store({ pairs: ['BTC/USD', 7, '', 'BTC/USD'] });
    expect(loadSettings().pairs).toEqual(['BTC/USD']);
    store({ pairs: [] });
    expect(loadSettings().pairs.length).toBeGreaterThan(0); // an empty universe draws no page
  });

  it('drops keys the app has no meaning for and keeps real values', () => {
    store({ injected: { attacker: true }, aiApiKey: 'sk-test', newsApiKey: '' });
    const s = loadSettings();
    expect('injected' in s).toBe(false);
    expect(s.aiApiKey).toBe('sk-test');
    expect(s.newsApiKey).toBe(''); // an emptied field is a choice, not corruption
  });

  it('accepts activeStrategyData only as an object or null', () => {
    store({ activeStrategyData: 'junk' });
    expect(loadSettings().activeStrategyData).toBeNull();
    store({ activeStrategyData: { title: 'Breakout', entryRules: ['buy'] } });
    expect(loadSettings().activeStrategyData.title).toBe('Breakout');
  });

  it('does not rewrite defaultPair against the user wishes', () => {
    store({ pairs: ['BTC/USD'], defaultPair: 'XAU/USD' });
    expect(loadSettings().defaultPair).toBe('XAU/USD');
  });
});
