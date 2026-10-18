import { describe, expect, it } from 'vitest';
import {
  isLoopback, hostAllowed, allowedOrigin, requestUrl, sanitizeSubscribe, hasOwn,
  MAX_SUBSCRIBE_SYMBOLS, MAX_SUBSCRIBE_TFS,
} from '../server/security.js';
import { TF_TO_TV, toTvSymbol, normHistory } from '../server/feed.js';

describe('bridge access control', () => {
  it('accepts every loopback spelling and nothing else', () => {
    for (const addr of ['127.0.0.1', '127.4.5.6', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(isLoopback(addr)).toBe(true);
    }
    for (const addr of ['192.168.1.5', '10.0.0.2', '8.8.8.8', '::ffff:192.168.0.1', undefined, null, '']) {
      expect(isLoopback(addr)).toBe(false);
    }
  });

  it('refuses a rebinding Host even when the peer is loopback', () => {
    for (const host of ['localhost:5178', '127.0.0.1:5178', '[::1]:5178', 'localhost']) {
      expect(hostAllowed(host)).toBe(true);
    }
    for (const host of ['attacker.example', 'attacker.example:5178', '192.168.1.5:5178', 'localhost.evil.com', undefined]) {
      expect(hostAllowed(host)).toBe(false);
    }
    expect(hostAllowed('attacker.example', true)).toBe(true);
  });

  it('gives CORS only to the terminal page itself', () => {
    expect(allowedOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(allowedOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
    // a suffix trick must not read as local, and a foreign page must get no header
    expect(allowedOrigin('http://localhost:5173.evil.com')).toBeNull();
    expect(allowedOrigin('https://evil.example')).toBeNull();
    expect(allowedOrigin('null')).toBeNull();
    expect(allowedOrigin('')).toBeNull();
    expect(allowedOrigin(undefined)).toBeNull();
  });

  it('returns null instead of throwing on a malformed Host', () => {
    const url = requestUrl('/api/status?x=1', 'a b');
    expect(url).toBeNull();
    expect(requestUrl('/api/trades?limit=5', 'localhost:5178').pathname).toBe('/api/trades');
    expect(requestUrl('/api/trades?limit=5', 'localhost:5178').searchParams.get('limit')).toBe('5');
  });
});

describe('subscribe message sanitizing', () => {
  it('bounds and cleans both arrays', () => {
    const many = Array.from({ length: 500 }, (_, i) => `PAIR/${i}`);
    const { symbols, tfs } = sanitizeSubscribe(
      { symbols: [...many, ...many], tfs: ['1m', '1m', '99m', 'constructor', 7] },
      TF_TO_TV,
    );
    expect(symbols.length).toBeLessThanOrEqual(MAX_SUBSCRIBE_SYMBOLS);
    expect(tfs).toEqual(['1m']);
    expect(tfs.length).toBeLessThanOrEqual(MAX_SUBSCRIBE_TFS);
  });

  it('drops non-strings and oversized names; odd names stay harmless strings', () => {
    const { symbols, tfs } = sanitizeSubscribe(
      { symbols: [42, '', '   ', 'X'.repeat(60), 'BTC/USD'], tfs: ['__proto__', 'toString', '15m'] },
      TF_TO_TV,
    );
    expect(symbols).toEqual(['BTC/USD']);
    expect(tfs).toEqual(['15m']);
    // an inherited key reaching the mapper must still come out as a plain string
    expect(toTvSymbol('__proto__')).toBe('FX:__proto__');
  });

  it('survives a message with no arrays at all', () => {
    expect(sanitizeSubscribe({}, TF_TO_TV)).toEqual({ symbols: [], tfs: [] });
    expect(sanitizeSubscribe(null, TF_TO_TV)).toEqual({ symbols: [], tfs: [] });
  });
});

describe('symbol mapping is prototype-safe', () => {
  it('maps known instruments to their feed symbols', () => {
    expect(toTvSymbol('BTC/USD')).toBe('COINBASE:BTCUSD');
    expect(toTvSymbol('JP225')).toBe('FPMARKETS:JP225');
    expect(toTvSymbol('US100')).toBe('CAPITALCOM:US100');
    expect(toTvSymbol('AAPL')).toBe('NASDAQ:AAPL');
    expect(toTvSymbol('EUR/USD')).toBe('FX:EURUSD');
  });

  it('never returns an inherited object or function for an odd key', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const out = toTvSymbol(key);
      expect(typeof out).toBe('string');
      expect(out.startsWith('FX:')).toBe(true);
    }
    expect(hasOwn(TF_TO_TV, 'constructor')).toBe(false);
  });

  it('serializes candles ascending, unique and capped', () => {
    const long = Array.from({ length: 500 }, (_, i) => ({
      time: i + 1e9, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3.7,
    }));
    const out = normHistory(long);
    expect(out.length).toBe(320);
    expect(out[0].time).toBe(1e9 + 180);
    expect(out[out.length - 1].volume).toBe(4);

    const dup = normHistory([
      { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: 100, open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { time: 90, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    expect(dup.map((c) => [c.time, c.close])).toEqual([[90, 1], [100, 2]]);
  });
});
