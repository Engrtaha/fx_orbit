// ── Feed mapping and serialization ───────────────────────────────────────────
// FxOrbit symbol → TradingView symbol, and TradingView payload → the engine's
// candle/quote serialization. Pure functions only, so both the bridge and its
// tests read the same rules without starting a server.

import { hasOwn } from './security.js';

export const HISTORY_COUNT = 300;
export const MAX_CANDLES = 320;

// FxOrbit timeframe → TradingView timeframe
export const TF_TO_TV = { '1m': '1', '5m': '5', '15m': '15', '1H': '60', '4H': '240', '1D': 'D' };

const TV_INDICES = {
  US100: 'CAPITALCOM:US100', US500: 'CAPITALCOM:US500', US30: 'CAPITALCOM:US30',
  GER40: 'CAPITALCOM:GER40', UK100: 'CAPITALCOM:UK100', FR40: 'CAPITALCOM:FR40',
  JP225: 'FPMARKETS:JP225', HK50: 'CAPITALCOM:HK50',
};
const TV_STOCKS = new Set(['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META']);
// Crypto trades against USD on Coinbase; TV's flagship BINANCE pairs quote USDT.
const TV_CRYPTO = {
  'BTC/USD': 'COINBASE:BTCUSD', 'ETH/USD': 'COINBASE:ETHUSD', 'SOL/USD': 'COINBASE:SOLUSD',
  'BNB/USD': 'COINBASE:BNBUSD', 'XRP/USD': 'COINBASE:XRPUSD', 'DOGE/USD': 'COINBASE:DOGEUSD',
  'ADA/USD': 'COINBASE:ADAUSD',
};

// hasOwn, not truthiness: an object literal inherits from Object.prototype, so
// MAP['__proto__'] and MAP['toString'] are truthy and would hand a non-string
// symbol to TradingView for anything a client can name.
export function toTvSymbol(sym) {
  if (hasOwn(TV_CRYPTO, sym)) return TV_CRYPTO[sym];
  if (hasOwn(TV_INDICES, sym)) return TV_INDICES[sym];
  if (TV_STOCKS.has(sym)) return `NASDAQ:${sym}`;
  return `FX:${String(sym).replace('/', '')}`;
}

// Normalize a TradingView candle into the FxOrbit serialization standard:
// unix-second time, plain floats, integer volume, ascending unique order.
export function normCandle(c) {
  return {
    time: Math.floor(c.time),
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: Math.round(c.volume ?? 0),
  };
}

export function normHistory(candles) {
  const sorted = [...candles].map(normCandle).sort((a, b) => a.time - b.time);
  const out = [];
  for (const c of sorted) {
    if (out.length && out[out.length - 1].time === c.time) out[out.length - 1] = c;
    else out.push(c);
  }
  while (out.length > MAX_CANDLES) out.shift();
  return out;
}

export function normQuote(q) {
  return {
    price: q.lp ?? null,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    change: q.ch ?? null,
    changePct: q.chp ?? null,
    volume: q.volume != null ? Math.round(q.volume) : null,
    time: q.lp_time ?? null,
  };
}
