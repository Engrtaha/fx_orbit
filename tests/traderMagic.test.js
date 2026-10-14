import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['AAPL', 'US100', 'XAU/USD'], defaultPair: 'AAPL' });
const tm = await import('../src/data/traderMagic.js');
const { aiSupportsChat, aiServesDecisions, aiSupportsVision } = await import('../src/utils/ai.js');

// A state object only needs the fields the level math reads.
const state = (over = {}) => ({
  symbol: 'AAPL',
  decimals: 2,
  pip: 0.01,
  spread: 8,
  mid: 245.32,
  candlesByTf: new Map([['1m', [{ high: 246, low: 244 }]]]),
  ...over,
});

const now = () => Math.floor(Date.now() / 1000);

describe('TraderMagic symbol mapping', () => {
  it('resolves only instruments this terminal trades', () => {
    const pairs = ['AAPL', 'US100', 'XAU/USD'];
    expect(tm.tmPairFor('AAPL', pairs)).toBe('AAPL');
    expect(tm.tmPairFor('xau/usd', pairs)).toBe('XAU/USD');
    expect(tm.tmPairFor('BTC/USD', pairs)).toBeNull();
    expect(tm.tmPairFor('', pairs)).toBeNull();
  });

  it('drops the dashboard bookkeeping keys and keeps symbol rows', () => {
    const rows = tm.tmEntries({
      AAPL: { symbol: 'AAPL', signal: 'buy' },
      _system: { trading_enabled: true },
      _debug: { keys: {} },
      _trade_results: {},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'AAPL', symbol: 'AAPL', signal: 'buy' });
  });

  it('finds the row for an enabled pair and nothing for a foreign one', () => {
    const data = { AAPL: { symbol: 'AAPL', signal: 'buy' }, 'BTC/USD': { symbol: 'BTC/USD', signal: 'sell' } };
    expect(tm.tmFindEntry(data, 'AAPL', ['AAPL'])?.signal).toBe('buy');
    expect(tm.tmFindEntry(data, 'US100', ['US100', 'AAPL'])).toBeNull();
  });
});

describe('TraderMagic normalization', () => {
  it('scales confidence with how far RSI sits from the midline', () => {
    expect(tm.tmConfidence(50)).toBe(50);
    expect(tm.tmConfidence(30)).toBe(90);
    expect(tm.tmConfidence(70)).toBe(90);
    expect(tm.tmConfidence(10)).toBe(95); // clamped at the ceiling
    expect(tm.tmConfidence(null)).toBe(50);
  });

  it('maps buy to a LONG whose levels bracket the live price', () => {
    const sig = tm.normalizeTmSignal({ signal: 'buy', rsi: 28.4, price: 245.1, timestamp: now() }, state(), '15m');
    expect(sig.side).toBe('LONG');
    expect(sig.source).toBe('TraderMagic');
    expect(sig.confidence).toBe(93);
    expect(sig.sl).toBeLessThan(sig.entry);
    expect(sig.tp).toBeGreaterThan(sig.entry);
    expect(sig.rr).toBe(2.5); // the app-wide reward:risk standard
    expect(sig.reasons[0]).toContain('RSI 28.4');
  });

  it('maps sell to SHORT and hold to a level-less WAIT', () => {
    expect(tm.normalizeTmSignal({ signal: 'sell', rsi: 71, timestamp: now() }, state(), '15m').side).toBe('SHORT');
    const hold = tm.normalizeTmSignal({ signal: 'hold', rsi: 50, timestamp: now() }, state(), '15m');
    expect(hold.side).toBe('WAIT');
    expect(hold.sl).toBeNull();
    expect(hold.tp).toBeNull();
  });

  it('treats an unusable decision as WAIT rather than guessing a side', () => {
    expect(tm.normalizeTmSignal({ signal: null, rsi: 40, timestamp: now() }, state(), '15m').side).toBe('WAIT');
    expect(tm.normalizeTmSignal({ signal: 'yolo', rsi: 40, timestamp: now() }, state(), '15m').side).toBe('WAIT');
  });

  it('refuses to trade a stale row and says why', () => {
    const staleTs = now() - (30 * 60);
    const sig = tm.normalizeTmSignal({ signal: 'buy', rsi: 25, timestamp: staleTs }, state(), '15m');
    expect(sig.stale).toBe(true);
    expect(sig.side).toBe('WAIT');
    expect(sig.reasons.join(' ')).toContain('not polling live');
  });

  it('accepts millisecond timestamps from the bot', () => {
    expect(tm.tmAgeMs({ timestamp: Date.now() })).toBeLessThan(5000);
    expect(tm.tmAgeMs({ timestamp: null })).toBeNull();
  });
});

describe('fetchTmData', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads /api/data off the configured base, trailing slash stripped', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), signal: opts.signal });
      return { ok: true, json: async () => ({ AAPL: { signal: 'buy' } }) };
    }));
    const data = await tm.fetchTmData({ aiBaseUrl: 'http://localhost:9753/' });
    expect(calls[0].url).toBe('http://localhost:9753/api/data');
    expect(calls[0].signal).toBeTruthy(); // the timeout must actually abort
    expect(data.AAPL.signal).toBe('buy');
  });

  it('falls back to the dashboard default when no URL is set', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      seen = String(url);
      return { ok: true, json: async () => ({}) };
    }));
    await tm.fetchTmData({});
    expect(seen).toBe('http://localhost:9753/api/data');
  });

  it('surfaces an unreachable bot and an error payload as failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(tm.fetchTmData({ aiBaseUrl: 'http://localhost:9753' })).rejects.toThrow('TraderMagic responded 404');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: 'redis down' }) })));
    await expect(tm.fetchTmData({ aiBaseUrl: 'http://localhost:9753' })).rejects.toThrow('redis down');
  });
});

describe('provider capabilities', () => {
  it('keeps the bot out of every prompt-driven surface', () => {
    expect(aiSupportsChat({ aiProvider: 'tradermagic' })).toBe(false);
    expect(aiSupportsChat({ aiProvider: 'ollama' })).toBe(true);
    expect(aiSupportsChat({ aiProvider: 'openai' })).toBe(true);
    expect(aiSupportsChat({})).toBe(true); // unknown provider still resolves to openai
    expect(aiServesDecisions({ aiProvider: 'tradermagic' })).toBe(true);
    expect(aiServesDecisions({ aiProvider: 'ollama' })).toBe(false);
    expect(aiSupportsVision({ aiProvider: 'tradermagic', aiModel: '' })).toBe(false);
  });
});
