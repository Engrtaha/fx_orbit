// ── FxOrbit simulated market engine ──────────────────────────────────────────
// Generates realistic candle history per pair and streams live ticks via a
// tiny pub/sub. Data is simulated client-side; anchors sit near real market
// levels so the terminal feels alive without an API key.

import {
  accountBalance, inAccount, loadSettings, saveSettings, UNIVERSE, loadStrategies,
} from './settings';
import { isReversalBook, strategyMaxHoldMs, strategyRewardRisk } from '../utils/riskReward';

export const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D'];

const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '4H': 240, '1D': 1440 };

// closeTrade pays `pips * lots / 0.1`, so one lot is worth $10 per pip. A flat
// 0.1 lot therefore turned a 237-point US100 stop into a $237 loss on a $126
// account; sizing off the stop instead makes every stop-out cost the user's
// Risk Per Trade setting of equity, whatever the instrument is.
// The floor is fractional on purpose: at 0.01 lot ($0.10/pip) a $126 account
// risking 2% ($2.52) was overridden by any stop wider than 25 pips, and a
// BTC/USD volatility stop is several hundred — one trade lost $50–80 and one
// target paid $200, the "best trade" of an account that should risk $2.52.
const MIN_LOTS = 0.000001;
const MAX_LOTS = 10;
const PIP_VALUE_PER_LOT = 10;
const EMA_FAST = 9;
const EMA_SLOW = 21;

// How long a position may sit before the time stop closes it, in wall-clock
// time. It used to be 240 engine ticks — 3.6 minutes — so a stop sized from
// 15-minute volatility with a 1:4.5 target was almost always closed long before
// it could reach either level. A strategy's own rule ("exit after 4 hours")
// overrides these per-source defaults.
const HOLD_MS = { default: 4 * 3600e3 }; // 16 bars of the 15m chart the levels come from
const HISTORY_RETRY_MS = 30_000;

// Bars are bucketed on epoch-aligned boundaries (see genHistory), so the wall
// clock alone says when the running candle closes: 4H bars at 00/04/08… UTC
// and daily bars at midnight UTC.
export const tfPeriodMs = (tf) => (TF_MINUTES[tf] ?? 1) * 60000;

export const barCloseIn = (tf, now = Date.now()) => {
  const period = tfPeriodMs(tf);
  return period - (now % period);
};

const CCY_COLORS = {
  EUR: ['#3b82f6', '#6366f1'], USD: ['#10b981', '#0d9488'], GBP: ['#8b5cf6', '#d946ef'],
  JPY: ['#f43f5e', '#fb7185'], CHF: ['#ef4444', '#f59e0b'], AUD: ['#f59e0b', '#f97316'],
  NZD: ['#eab308', '#ca8a04'], CAD: ['#dc2626', '#f97316'], XAU: ['#fbbf24', '#d97706'],
  XAG: ['#94a3b8', '#64748b'],
  BTC: ['#f7931a', '#d97706'], ETH: ['#8b9df0', '#6366f1'], SOL: ['#14f195', '#0ea5e9'],
  BNB: ['#f0b90b', '#b45309'], XRP: ['#60a5fa', '#64748b'], DOGE: ['#c2a633', '#926e2a'],
  ADA: ['#3468d1', '#6366f1'],
};
export const ccyGradient = (code) => CCY_COLORS[code] ?? ['#64748b', '#475569'];

export const SESSIONS = [
  { name: 'Sydney',    utc: [21, 6] },
  { name: 'Tokyo',     utc: [0, 9]  },
  { name: 'London',    utc: [8, 17] },
  { name: 'New York',  utc: [13, 22] },
];

export const sessionOpen = (s, hourUtc) => {
  const [a, b] = s.utc;
  return a < b ? hourUtc >= a && hourUtc < b : hourUtc >= a || hourUtc < b;
};

// FX and the index CFDs trade 24/5: the tape stops when New York closes on
// Friday (22:00 UTC) and prints again when Sydney opens on Sunday. Whatever the
// feed shows in between is Friday's last print, not a live price. Crypto is the
// exception — `alwaysOpen` instruments keep trading straight through the
// weekend, so the close is decided per symbol, never for the book as a whole.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const reopenLabel = (d) => (d
  ? `${WEEKDAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`
  : '');

export function marketClosed(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const closed = (day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22);
  if (!closed) return { closed: false, reopensAt: null };
  const reopensAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22));
  reopensAt.setUTCDate(reopensAt.getUTCDate() + (day === 5 ? 2 : day === 6 ? 1 : 0));
  return { closed: true, reopensAt };
}

// The weekend window only binds instruments that actually shut. Crypto pairs
// carry `alwaysOpen` in the universe catalog and stay live Saturday to Sunday.
export function symbolMarketClosed(symbol, now = new Date()) {
  const def = UNIVERSE.find((d) => d.symbol === symbol);
  if (def?.alwaysOpen) return { closed: false, reopensAt: null };
  return marketClosed(now);
}

export const fmt = (v, d) =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genHistory(def, tfMin, anchor) {
  const rng = seededRand(hashStr(`${def.symbol}:${tfMin}`));
  const count = 300;
  const step = tfMin * 60;
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const volC = def.vol * Math.sqrt(tfMin);
  const candles = [];
  let price = anchor * (1 + (rng() - 0.5) * 0.012);
  for (let i = count - 1; i >= 0; i--) {
    const open = price;
    const close = open * (1 + (rng() - 0.5) * 2 * volC);
    const high = Math.max(open, close) * (1 + rng() * volC * 0.7);
    const low = Math.min(open, close) * (1 - rng() * volC * 0.7);
    const volume = Math.round(90 + rng() * 240 + (Math.abs(close - open) / volC) * 180);
    candles.push({ time: end - i * step, open, high, low, close, volume });
    price = close;
  }
  const k = anchor / candles[candles.length - 1].close;
  return candles.map((c) => ({
    ...c,
    open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k,
  }));
}

function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - 100 / (1 + gains / losses);
}

function emaSeries(closes, period) {
  if (!closes.length) return [];
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
  return out;
}

class MarketEngine {
  constructor() {
    this.listeners = new Set();
    this.timer = null;
    this.tickCount = 0;
    this.states = new Map();
    this.defs = new Map(UNIVERSE.map((d) => [d.symbol, d]));
    this.trades = [];
    this.tradeSeq = 0;
    this.strategyOpen = new Map(); // `${strategyId}:${symbol}` -> tradeId
    this.autoOpen = new Map();     // symbol -> tradeId
    this.strategies = loadStrategies();
    this.started = false;
  }

  createState(def) {
    const rng = seededRand(hashStr(def.symbol + '@day'));
    const dayOpen = def.price * (1 + (rng() - 0.5) * 0.009);
    const state = {
      ...def,
      mid: def.price,
      dir: 0,
      dayOpen,
      dayHigh: Math.max(dayOpen, def.price) * 1.0004,
      dayLow: Math.min(dayOpen, def.price) * 0.9996,
      spark: [],
      candlesByTf: new Map(),
      rsi: 50, momentum: 0, score: 0, signal: 'NEUTRAL', confidence: 54,
      detailTick: -1, detail: null,
      tv: false,
      // Timeframes whose bars came from the feed. Any other timeframe in
      // candlesByTf is the seeded random walk (see getCandles).
      liveTfs: new Set(),
    };
    const m1 = genHistory(def, 1, def.price);
    state.candlesByTf.set('1m', m1);
    state.liveCandle = m1[m1.length - 1];
    state.mid = state.liveCandle.close;
    state.spark = m1.slice(-90).map((c) => c.close);
    this.derive(state);
    return state;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const settings = loadSettings();
    for (const sym of settings.pairs) {
      const def = this.defs.get(sym);
      if (def && !this.states.has(sym)) this.states.set(sym, this.createState(def));
    }
    // Paint immediately: without this the first snapshot only arrives from
    // tick() 900ms later, so a hard reload of #/charts renders nothing and
    // #/signals shows a Generate button that silently does nothing.
    this.emit();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 900);
  }
  applyUniverse(symbols) {
    const next = new Set(symbols);
    for (const sym of [...this.states.keys()]) {
      if (next.has(sym)) continue;
      // Exits are only checked for live states, so an open trade left behind here
      // could never hit its TP/SL or time stop. Close it at the last real price
      // while its state — and therefore its pip size — is still available. With
      // no live price the walk's mark is fiction, so it closes flat at entry.
      const s = this.states.get(sym);
      for (const t of this.trades) {
        if (t.status === 'open' && t.symbol === sym) this.closeTrade(t, s.tv ? s.mid : t.entry, 'Pair disabled');
      }
      this.states.delete(sym);
    }
    for (const sym of next) {
      const def = this.defs.get(sym);
      if (def && !this.states.has(sym)) this.states.set(sym, this.createState(def));
    }
    saveSettings({ pairs: [...next] });
    this.emit();
  }

  derive(s) {
    const c = s.liveCandle;
    s.bid = c.close - (s.spread * s.pip) / 2;
    s.ask = c.close + (s.spread * s.pip) / 2;
    s.change = c.close - s.dayOpen;
    s.changePct = (s.change / s.dayOpen) * 100;
  }

  refreshIndicators(s) {
    const m1 = s.candlesByTf.get('1m');
    if (!m1 || !m1.length) return;
    s.liveCandle = m1[m1.length - 1];
    const closes = m1.map((c) => c.close);
    const next = s.liveCandle.close;
    s.rsi = calcRsi(closes);
    const back = closes[closes.length - 11] ?? closes[0];
    s.momentum = ((next - back) / back) * 100;

    // RSI past 75 / under 25 is stretched, not strong: it used to add the full
    // two trend points there, so RSI 88 read as a high-confidence LONG at
    // exactly the spot a reversal is likeliest. A stretched reading now adds
    // nothing; the reversal detector decides whether it actually turned.
    const score =
      (s.rsi >= 75 ? 0 : s.rsi > 65 ? 2 : s.rsi > 55 ? 1 : 0) +
      (s.rsi <= 25 ? 0 : s.rsi < 35 ? -2 : s.rsi < 45 ? -1 : 0) +
      (s.momentum > 0.05 ? 2 : s.momentum > 0.015 ? 1 : 0) +
      (s.momentum < -0.05 ? -2 : s.momentum < -0.015 ? -1 : 0);
    s.score = score;
    s.signal =
      score >= 3 ? 'STRONG BUY' : score >= 1 ? 'BUY'
      : score <= -3 ? 'STRONG SELL' : score <= -1 ? 'SELL' : 'NEUTRAL';
    s.confidence = Math.min(97, 54 + Math.abs(score) * 10);
  }

  tick() {
    this.tickCount += 1;
    const cadence = this.tickCount % 8 === 0;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const s of this.states.values()) {
      if (s.tv) {
        // Price is driven by the TradingView feed; tick() only runs the
        // trade/strategy bookkeeping on top of the realtime candles.
        this.refreshIndicators(s);
        if (this.bookOpenFor(s)) {
          this.checkTradeExits(s);
          this.maybeAutoTrade(s);
          if (cadence) this.checkStrategies(s);
        }
        continue;
      }
      const stepVol = s.vol * 0.12;
      const prev = s.liveCandle.close;
      const next = Math.max(prev * (1 + (Math.random() - 0.5) * 2 * stepVol), s.pip * 10);
      s.dir = next > prev ? 1 : next < prev ? -1 : 0;
      for (const [tf, arr] of s.candlesByTf) {
        const last = arr[arr.length - 1];
        last.close = next;
        if (next > last.high) last.high = next;
        if (next < last.low) last.low = next;
        last.volume += Math.round(2 + Math.random() * 14);
        // Bars roll on the wall clock, like the real feed and the countdown do.
        // Adding a bar every 8 ticks advanced simulated time ~8x faster than the
        // clock, so the chart painted bars minutes into the future.
        const step = TF_MINUTES[tf] * 60;
        const bucket = nowSec - (nowSec % step);
        if (bucket > last.time) {
          arr.push({
            time: bucket,
            open: last.close,
            high: last.close * 1.00002,
            low: last.close * 0.99998,
            close: last.close,
            volume: Math.round(60 + Math.random() * 140),
          });
          if (arr.length > 320) arr.shift();
        }
      }
      s.mid = next;
      s.dayHigh = Math.max(s.dayHigh, next);
      s.dayLow = Math.min(s.dayLow, next);
      s.spark.push(next);
      if (s.spark.length > 90) s.spark.shift();

      this.refreshIndicators(s);
      this.derive(s);
      // No trade management here: this is the random walk, not a market. After a
      // reload the walk starts at the catalog seed (BTC 81,470, gold 2,384), so
      // a restored position was judged against a price thousands away — phantom
      // TP/SL hits and Time Stops booked at a made-up mark. Open trades wait for
      // the feed; openTrade() already refuses to open one without it.
    }
    this.emit();
  }

  // While the tape is shut no position may be opened, closed or time-stopped:
  // the last print is stale, so acting on it books phantom P&L into history.
  // Crypto instruments never shut, so the check is per symbol.
  bookOpenFor(s) {
    return s.alwaysOpen ? true : !marketClosed().closed;
  }

  // ── TradingView realtime ingest ─────────────────────────────────────────────
  // All TV payloads already use the engine candle serialization
  // ({ time: unixSeconds, open, high, low, close, volume }), so ingestion is
  // a straight merge; symbols flagged tv=true skip the simulated random walk.

  scheduleEmit() {
    if (this._emitQueued) return;
    this._emitQueued = true;
    setTimeout(() => {
      this._emitQueued = false;
      this.emit();
    }, 250);
  }

  setTvLive(symbol, live) {
    const s = this.states.get(symbol);
    if (s) s.tv = live;
  }

  markAllTv(live) {
    for (const s of this.states.values()) s.tv = live;
  }

  // There is deliberately no sim → live "rebase" of open trades. Every position
  // is opened on a live price (openTrade refuses otherwise) and none is managed
  // on the random walk, so a trade's levels are always real. The old rebase
  // multiplied a trade restored from the archive by live/seed — on gold about
  // 1.7× — stretching its entry, stop, target and therefore its P&L.

  // ── Live higher timeframes ──────────────────────────────────────────────────
  // The feed streams 1-minute bars only. Any other timeframe used to be the
  // seeded random walk unless the Charts page happened to load it — and the
  // 15m ATR that sizes every stop, the bars the signal model reads and the
  // reversal detector all ran on those invented candles. A timeframe is now
  // backfilled from the bridge on first use (tvClient installs the loader) and
  // kept current by folding each live 1m update into its running bar.
  requestHistory(symbol, tf) {
    if (!this.historyLoader) return;
    this.historyAsked ??= new Map();
    const key = `${symbol}:${tf}`;
    const at = this.historyAsked.get(key) ?? 0;
    if (Date.now() - at < HISTORY_RETRY_MS) return;
    this.historyAsked.set(key, Date.now());
    Promise.resolve()
      .then(() => this.historyLoader(symbol, tf))
      .catch(() => { /* bridge busy or offline — retried after HISTORY_RETRY_MS */ });
  }

  // Real bars for a timeframe, or null while they are not loaded yet (the load
  // is requested on the way). Only meaningful on a live symbol.
  liveCandles(symbol, tf) {
    const s = this.states.get(symbol);
    if (!s?.tv) return null;
    if (tf === '1m' || s.liveTfs.has(tf)) return s.candlesByTf.get(tf) ?? null;
    this.requestHistory(symbol, tf);
    return null;
  }

  // Roll a live price into every loaded higher timeframe's running bar, opening
  // a new epoch-aligned bar when the period turns over.
  foldLive(s, price, timeSec, high = price, low = price) {
    for (const tf of s.liveTfs) {
      if (tf === '1m') continue;
      const arr = s.candlesByTf.get(tf);
      const last = arr?.[arr.length - 1];
      if (!last) continue;
      const step = (TF_MINUTES[tf] ?? 1) * 60;
      const bucket = timeSec - (timeSec % step);
      if (bucket > last.time) {
        arr.push({ time: bucket, open: last.close, high, low, close: price, volume: 0 });
        if (arr.length > 320) arr.shift();
      } else if (bucket === last.time) {
        last.close = price;
        if (high > last.high) last.high = high;
        if (low < last.low) last.low = low;
      }
    }
  }

  applyTvHistory(symbol, tf, candles) {
    const s = this.states.get(symbol);
    if (!s || !candles?.length) return;
    const arr = candles
      .map((c) => ({
        time: Math.floor(c.time),
        open: +c.open,
        high: +c.high,
        low: +c.low,
        close: +c.close,
        volume: Math.round(c.volume ?? 0),
      }))
      .sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const c of arr) {
      if (deduped.length && deduped[deduped.length - 1].time === c.time) deduped[deduped.length - 1] = c;
      else deduped.push(c);
    }
    while (deduped.length > 320) deduped.shift();
    s.candlesByTf.set(tf, deduped);
    s.liveTfs.add(tf);
    if (tf === '1m') {
      const prev = s.liveCandle?.close;
      const last = deduped[deduped.length - 1];
      s.dir = prev != null && last.close > prev ? 1 : last.close < prev ? -1 : 0;
      s.mid = last.close;
      // Re-anchor the day range to the real window; the seeded sim anchor
      // would otherwise distort change/changePct.
      s.dayOpen = deduped[0].open;
      s.dayHigh = Math.max(...deduped.map((c) => c.high));
      s.dayLow = Math.min(...deduped.map((c) => c.low));
      s.spark = deduped.slice(-90).map((c) => c.close);
      this.refreshIndicators(s);
      this.derive(s);
    }
    s.tv = true;
    this.scheduleEmit();
  }

  applyTvCandle(symbol, tf, candle) {
    const s = this.states.get(symbol);
    if (!s) return;
    const c = {
      time: Math.floor(candle.time),
      open: +candle.open,
      high: +candle.high,
      low: +candle.low,
      close: +candle.close,
      volume: Math.round(candle.volume ?? 0),
    };
    let arr = s.candlesByTf.get(tf);
    if (!arr) {
      arr = [];
      s.candlesByTf.set(tf, arr);
    }
    const last = arr[arr.length - 1];
    if (!last || c.time > last.time) {
      arr.push(c);
      if (arr.length > 320) arr.shift();
    } else if (c.time === last.time) {
      arr[arr.length - 1] = c;
    } else {
      return; // stale bar
    }
    s.tv = true;
    if (tf !== '1m') {
      this.scheduleEmit();
      return;
    }
    s.liveTfs.add('1m');
    this.foldLive(s, c.close, c.time, c.high, c.low);
    const prev = s.liveCandle?.close;
    s.dir = prev != null && c.close > prev ? 1 : c.close < prev ? -1 : 0;
    s.mid = c.close;
    s.dayHigh = Math.max(s.dayHigh, c.high);
    s.dayLow = Math.min(s.dayLow, c.low);
    s.spark.push(c.close);
    if (s.spark.length > 90) s.spark.shift();
    this.refreshIndicators(s);
    this.derive(s);
    if (this.bookOpenFor(s)) {
      this.checkTradeExits(s);
      this.maybeAutoTrade(s);
    }
    this.scheduleEmit();
  }

  applyTvTick(symbol, tick) {
    const s = this.states.get(symbol);
    if (!s || tick.price == null) return;
    const prev = s.mid;
    s.dir = tick.price > prev ? 1 : tick.price < prev ? -1 : 0;
    s.mid = tick.price;
    s.dayHigh = Math.max(s.dayHigh, tick.price);
    s.dayLow = Math.min(s.dayLow, tick.price);
    s.spark.push(tick.price);
    if (s.spark.length > 90) s.spark.shift();
    const m1 = s.candlesByTf.get('1m');
    const last = m1?.[m1.length - 1];
    if (last) {
      last.close = tick.price;
      if (tick.price > last.high) last.high = tick.price;
      if (tick.price < last.low) last.low = tick.price;
      if (tick.volume != null) last.volume = Math.round(tick.volume);
      s.liveCandle = last;
      this.foldLive(s, tick.price, last.time);
    }
    if (tick.bid != null) s.bid = tick.bid;
    if (tick.ask != null) s.ask = tick.ask;
    if (tick.change != null) s.change = tick.change;
    if (tick.changePct != null) s.changePct = tick.changePct;
    s.tv = true;
    if (this.bookOpenFor(s)) this.checkTradeExits(s);
    this.scheduleEmit();
  }

  emit() {
    const snap = [...this.states.values()];
    // One page failing must not stop the others from ever hearing about a price
    // again: listeners run in subscription order, so an uncaught throw here
    // silently freezes every surface below it — including the topbar.
    this.listeners.forEach((fn) => {
      try { fn(snap, this.tickCount); } catch { /* a broken subscriber stays broken, not fatal */ }
    });
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot() {
    return [...this.states.values()];
  }

  getState(symbol) {
    return this.states.get(symbol);
  }

  getCandles(symbol, tf) {
    const s = this.states.get(symbol);
    if (!s) return [];
    // A live symbol asks for the real bars; the walk below only stands in until
    // they arrive (applyTvHistory replaces it).
    if (s.tv && !s.liveTfs.has(tf)) this.requestHistory(symbol, tf);
    if (!s.candlesByTf.has(tf)) {
      s.candlesByTf.set(tf, genHistory(s, TF_MINUTES[tf] ?? 1, s.mid));
    }
    return s.candlesByTf.get(tf);
  }

  // ── Signal detail (entry / SL / TP / reasons) ──────────────────────────────
  getDetail(s) {
    if (s.detailTick === this.tickCount && s.detail) return s.detail;
    s.detailTick = this.tickCount;

    const c15 = this.getCandles(s.symbol, '15m');
    const atr = (() => {
      if (c15.length < 15) return s.mid * s.vol * 4;
      let sum = 0;
      for (let i = c15.length - 14; i < c15.length; i++) {
        const c = c15[i], p = c15[i - 1];
        sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      }
      return sum / 14;
    })();

    const side = s.score >= 1 ? 'LONG' : s.score <= -1 ? 'SHORT' : 'WAIT';
    const entry = s.mid;
    const slDist = 1.4 * atr;
    const tpDist = 3.5 * atr;
    const sl = side === 'SHORT' ? entry + slDist : entry - slDist;
    const tp = side === 'SHORT' ? entry - tpDist : entry + tpDist;
    const slPips = slDist / s.pip;
    const tpPips = tpDist / s.pip;

    const reasons = [];
    if (s.rsi >= 75) reasons.push(`RSI ${s.rsi.toFixed(0)} overbought — stretched, reversal risk`);
    else if (s.rsi >= 65) reasons.push(`RSI ${s.rsi.toFixed(0)} strong bullish momentum`);
    else if (s.rsi >= 55) reasons.push(`RSI ${s.rsi.toFixed(0)} bullish momentum`);
    else if (s.rsi <= 25) reasons.push(`RSI ${s.rsi.toFixed(0)} oversold — stretched, reversal risk`);
    else if (s.rsi <= 35) reasons.push(`RSI ${s.rsi.toFixed(0)} strong bearish momentum`);
    else if (s.rsi <= 45) reasons.push(`RSI ${s.rsi.toFixed(0)} bearish momentum`);
    if (s.momentum >= 0.015) reasons.push(`1m momentum +${s.momentum.toFixed(3)}% rising`);
    else if (s.momentum <= -0.015) reasons.push(`1m momentum ${s.momentum.toFixed(3)}% falling`);
    const hour = new Date().getUTCHours();
    const active = SESSIONS.filter((x) => sessionOpen(x, hour)).map((x) => x.name).join(' + ');
    if (active) reasons.push(`${active} session liquidity`);
    reasons.push(`Spread ${s.spread.toFixed(1)} pips — ${s.spread < 2 ? 'tight' : 'wide'} cost`);

    s.detail = { side, entry, sl, tp, rr: tpPips / Math.max(slPips, 0.01), slPips, tpPips, atr, reasons };
    return s.detail;
  }

  // ── Trade manager ──────────────────────────────────────────────────────────
  // The book starts empty and is restored from PostgreSQL on boot (see
  // src/data/persistence.js); there is no generated demo history.
  //
  // Every numeric column in trade_history is nullable — an open trade has no
  // exit, pips, pnl or closed_at at all — and the pages format those fields
  // directly, so a raw NULL would throw inside fmt() and blank the page.
  // Coerce once, at the archive boundary.
  loadTrades(rows) {
    const incoming = (rows ?? []).filter((r) => r?.id && r.symbol && r.side && r.status);
    if (!incoming.length) return 0;
    const byId = new Map();
    for (const r of incoming) {
      byId.set(r.id, {
        ...r,
        lots: Number(r.lots) || 0.1,
        entry: Number(r.entry) || 0,
        sl: Number(r.sl) || 0,
        tp: Number(r.tp) || 0,
        exit: Number(r.exit) || 0,
        pips: Number(r.pips) || 0,
        pnl: Number(r.pnl) || 0,
        openedAt: Number(r.openedAt) || 0,
        closedAt: r.status === 'open' ? null : (Number(r.closedAt) || 0),
        exitReason: r.exitReason ?? (r.status === 'open' ? null : 'Closed'),
        // A restored open trade must get a fresh time-stop window, not be
        // closed as "Time Stop" on the first tick after hydration.
        openTick: r.status === 'open' ? this.tickCount : 0,
      });
    }
    for (const t of this.trades) if (!byId.has(t.id)) byId.set(t.id, t);
    this.trades = [...byId.values()]
      .sort((a, b) => (b.closedAt ?? b.openedAt ?? 0) - (a.closedAt ?? a.openedAt ?? 0));
    for (const t of this.trades) {
      const m = /^T-(\d+)$/.exec(String(t.id));
      if (m && Number(m[1]) > this.tradeSeq) this.tradeSeq = Number(m[1]);
    }
    this.emit();
    return incoming.length;
  }

  openTrade({ symbol, side, source = 'Manual', strategyId = null, slPips, tpPips, note = null, maxHoldMs = null }) {
    const s = this.states.get(symbol);
    if (!s) return null;
    // Without the bridge the engine is a random walk, and those fills would sit
    // in the archived book forever and drag the balance with them.
    if (!s.tv) return null;
    const dir = side === 'BUY' ? 1 : -1;
    const entry = s.mid;
    const sl = entry - dir * slPips * s.pip;
    const tp = entry + dir * tpPips * s.pip;
    const trade = {
      id: `T-${String(++this.tradeSeq).padStart(3, '0')}`,
      symbol, side, lots: this.riskLots(slPips), entry, sl, tp,
      openedAt: Date.now(), openTick: this.tickCount,
      source, strategyId, status: 'open', note,
      maxHoldMs: Number(maxHoldMs) > 0 ? Number(maxHoldMs) : null,
    };
    this.trades.unshift(trade);
    return trade;
  }

  // Closed trades that belong to the current account (see inAccount): history
  // from before the account's start stays visible but stops moving the balance.
  accountTrades(settings = loadSettings()) {
    return this.trades.filter((t) => t.status === 'closed' && inAccount(t, settings));
  }

  realizedPnl(settings = loadSettings()) {
    return +this.accountTrades(settings).reduce((sum, t) => sum + (Number(t.pnl) || 0), 0).toFixed(2);
  }

  // The same number Portfolio and Dashboard show: the user's anchor plus the
  // realized P&L of the account's closed trades.
  accountEquity() {
    const settings = loadSettings();
    return accountBalance(settings, this.realizedPnl(settings));
  }

  // Settings → "Risk Per Trade (%)" is the user's number; the clamp keeps a
  // mistyped value (or a free-text 200) from sizing an account into one trade.
  riskPct() {
    const raw = Number(loadSettings().riskPerTrade);
    return Math.min(10, Math.max(0.1, Number.isFinite(raw) ? raw : 1)) / 100;
  }

  // A wide stop gets a smaller position, never a cheaper one. A blown account
  // trades the smallest unit until the user resets their anchor in Portfolio.
  riskLots(slPips) {
    const stop = Number(slPips);
    if (!Number.isFinite(stop) || stop <= 0) return MIN_LOTS;
    const lots = (this.accountEquity() * this.riskPct()) / (stop * PIP_VALUE_PER_LOT);
    // Rounded DOWN: rounding to nearest sized some stops a couple of percent
    // over the user's risk.
    return Math.min(MAX_LOTS, Math.max(MIN_LOTS, Math.floor(lots * 1e6) / 1e6));
  }

  // Pip size for a symbol, straight from the universe catalog. The live state is
  // not enough: a trade on a pair the user switched off has no state, and the
  // old 0.0001 guess was 100x wrong for JPY crosses, 10000x for DOGE and 10x for
  // US100 — it priced the P&L of every such close.
  pipFor(symbol) {
    return this.defs.get(symbol)?.pip ?? 0.0001;
  }

  closeTrade(t, exit, reason) {
    if (t.status !== 'open') return;
    t.status = 'closed';
    t.exit = exit;
    t.closedAt = Date.now();
    const dir = t.side === 'BUY' ? 1 : -1;
    t.pips = +(((exit - t.entry) * dir) / this.pipFor(t.symbol)).toFixed(1);
    t.pnl = +(t.pips * (t.lots / 0.1)).toFixed(2);
    t.exitReason = reason;
  }

  checkTradeExits(s) {
    for (const t of this.trades) {
      if (t.status !== 'open' || t.symbol !== s.symbol) continue;
      const dir = t.side === 'BUY' ? 1 : -1;
      if (dir > 0 && s.mid >= t.tp) this.closeTrade(t, t.tp, 'TP Hit');
      else if (dir > 0 && s.mid <= t.sl) this.closeTrade(t, t.sl, 'SL Hit');
      else if (dir < 0 && s.mid <= t.tp) this.closeTrade(t, t.tp, 'TP Hit');
      else if (dir < 0 && s.mid >= t.sl) this.closeTrade(t, t.sl, 'SL Hit');
      else if (Date.now() - (Number(t.openedAt) || Date.now()) > this.holdFor(t)) this.closeTrade(t, s.mid, 'Time Stop');
    }
  }

  // The trade's own hold time, else its strategy's rule, else the source default.
  // A trade restored from the archive has no maxHoldMs column, so it falls
  // back the same way — and keeps its real opening time, so one that overstayed
  // while the app was closed is time-stopped at the first live price.
  holdFor(t) {
    if (Number(t.maxHoldMs) > 0) return Number(t.maxHoldMs);
    if (t.strategyId) {
      const st = this.strategies.find((x) => x.id === t.strategyId);
      const ms = st ? strategyMaxHoldMs(st) : null;
      if (ms) return ms;
    }
    return HOLD_MS.default;
  }

  maybeAutoTrade(s) {
    const settings = loadSettings();
    if (!settings.autoTrade.includes(s.symbol)) return;
    if (this.autoOpen.has(s.symbol)) {
      const t = this.trades.find((x) => x.id === this.autoOpen.get(s.symbol));
      if (!t || t.status !== 'open') this.autoOpen.delete(s.symbol);
      else return;
    }
    if (Math.abs(s.score) < 3) return;
    const d = this.getDetail(s);
    const side = s.score > 0 ? 'BUY' : 'SELL';
    const t = this.openTrade({
      symbol: s.symbol, side, source: 'AI Signal',
      slPips: Math.max(d.slPips, 3), tpPips: Math.max(d.tpPips, 5),
    });
    if (t) this.autoOpen.set(s.symbol, t.id);
  }

  setAutoTrade(symbol, on) {
    const settings = loadSettings();
    const set = new Set(settings.autoTrade);
    if (on) set.add(symbol); else set.delete(symbol);
    saveSettings({ autoTrade: [...set] });
  }

  // ── Custom strategy execution ──────────────────────────────────────────────
  syncStrategies(list) {
    this.strategies = list;
    const ids = new Set(list.filter((x) => x.armed).map((x) => x.id));
    for (const [key, tradeId] of [...this.strategyOpen]) {
      if (!ids.has(key.split(':')[0])) this.strategyOpen.delete(key);
      else {
        const t = this.trades.find((x) => x.id === tradeId);
        if (!t || t.status !== 'open') this.strategyOpen.delete(key);
      }
    }
  }

  // An armed book trades the EMA cross on the instrument it names, in the
  // direction(s) its own rules describe. Levels come from the same volatility
  // math as every other fill: the 12/24-pip pair it used to read was dead config
  // no UI can write, and on BTC/USD (pip = 1) a 12-pip stop is 0.015% of price —
  // ordinary noise closed that trade within seconds.
  checkStrategies(s) {
    if (!this.strategies.length) return;
    const closes = (s.candlesByTf.get('1m') ?? []).map((c) => c.close);
    for (const st of this.strategies) {
      if (!st.armed) continue;
      if (st.pair !== s.symbol) continue;
      if (this.strategyOpen.has(`${st.id}:${s.symbol}`)) continue;

      const dirs = st.directions ?? [];
      const wantLong = !dirs.length || dirs.includes('bull');
      const wantShort = !dirs.length || dirs.includes('bear');
      const d = this.getDetail(s);
      let side = null;
      let slPips = Math.max(d.slPips, 3);

      if (isReversalBook(st)) {
        // A reversal book trades the reversal its rules describe — a swept swing
        // rejected, or RSI exhaustion broken — on its own timeframe, with the
        // stop beyond the swept extreme. An EMA cross is a trend signal and
        // would trade it the wrong way round. Each print is traded once.
        const tf = st.timeframes?.[0] ?? '15m';
        const bars = this.liveCandles(s.symbol, tf);
        const r = bars ? latestReversal(bars, s.mid) : null;
        this.reversalSeen ??= new Map();
        if (!r || this.reversalSeen.get(st.id) === r.time) continue;
        this.reversalSeen.set(st.id, r.time);
        if ((r.side === 'LONG' && !wantLong) || (r.side === 'SHORT' && !wantShort)) continue;
        side = r.side === 'LONG' ? 'BUY' : 'SELL';
        const beyond = r.side === 'SHORT' ? r.extreme - s.mid : s.mid - r.extreme;
        slPips = Math.max((beyond + 0.25 * d.atr) / s.pip, (0.5 * d.atr) / s.pip, 3);
      } else {
        if (closes.length < 30) continue; // too little history for a meaningful cross
        const fast = emaSeries(closes, EMA_FAST);
        const slow = emaSeries(closes, EMA_SLOW);
        const f0 = fast[fast.length - 2], f1 = fast[fast.length - 1];
        const w0 = slow[slow.length - 2], w1 = slow[slow.length - 1];
        if (f0 <= w0 && f1 > w1 && wantLong) side = 'BUY';
        else if (f0 >= w0 && f1 < w1 && wantShort) side = 'SELL';
      }
      if (!side) continue;

      // The book's own R:R ("TP at 1:4.5") sizes the target; the engine's 2.5
      // is only the default for a book that names none.
      const rr = strategyRewardRisk(st);
      const t = this.openTrade({
        symbol: s.symbol, side, source: 'Strategy', strategyId: st.id,
        slPips, tpPips: rr ? slPips * rr : Math.max(d.tpPips, 5),
        maxHoldMs: strategyMaxHoldMs(st),
      });
      if (t) this.strategyOpen.set(`${st.id}:${s.symbol}`, t.id);
    }
  }

  getTrades() {
    return this.trades;
  }

  tradeStats() {
    const closed = this.accountTrades();
    const open = this.trades.filter((t) => t.status === 'open');
    const netPnl = closed.reduce((a, t) => a + t.pnl, 0);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    return {
      netPnl: +netPnl.toFixed(2),
      winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
      closedCount: closed.length,
      openCount: open.length,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
    };
  }
}

export const engine = new MarketEngine();
export const volatilityPips = (s) => {
  const m1 = s.candlesByTf.get('1m');
  const tail = m1.slice(-20);
  if (!tail.length) return 0;
  return tail.reduce((acc, c) => acc + (c.high - c.low) / s.pip, 0) / tail.length;
};

// ── Reversal detection ───────────────────────────────────────────────────────
// The engine's own score follows momentum — RSI 70 counts as bullish — so on
// its own it can never call a top or a bottom. These are the two reversal
// prints the desk reads off closed bars, shared by the chart markers and the
// signal generator:
//   sweep      — the bar runs an ESTABLISHED swing high (low) — the extreme of
//                the prior N bars, set at least SWING_AGE bars ago and not exceeded
//                since — then closes back inside the range in the lower (upper)
//                half of its own bar: resting liquidity taken and rejected.
//                Without the age rule every bar of a steady trend "swept" the
//                bar before it and the chart was a wall of arrows.
//   exhaustion — RSI was stretched (>= 75 / <= 25) into the bar and the bar is
//                the FIRST to close through the previous bar's low (high).
export const REVERSAL_LOOKBACK = 20;
const SWING_AGE = 3;

export function reversalAt(candles, i, lookback = REVERSAL_LOOKBACK) {
  if (!Array.isArray(candles) || i < Math.max(lookback, 15) || i >= candles.length) return null;
  const c = candles[i];
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - lookback; j <= i - SWING_AGE; j++) {
    if (candles[j].high > hi) hi = candles[j].high;
    if (candles[j].low < lo) lo = candles[j].low;
  }
  let recentHi = -Infinity;
  let recentLo = Infinity;
  for (let j = i - SWING_AGE + 1; j < i; j++) {
    if (candles[j].high > recentHi) recentHi = candles[j].high;
    if (candles[j].low < recentLo) recentLo = candles[j].low;
  }
  if (recentHi <= hi && c.high > hi && c.close < hi && (c.high - c.close) / range >= 0.5) {
    return { side: 'SHORT', kind: 'sweep', time: c.time, level: hi, extreme: c.high };
  }
  if (recentLo >= lo && c.low < lo && c.close > lo && (c.close - c.low) / range >= 0.5) {
    return { side: 'LONG', kind: 'sweep', time: c.time, level: lo, extreme: c.low };
  }
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  const rsi = calcRsi(candles.slice(0, i).map((x) => x.close));
  if (rsi >= 75 && c.close < prev.low && c.close < c.open && prev.close >= prev2.low) {
    return { side: 'SHORT', kind: 'exhaustion', time: c.time, level: prev.low, extreme: Math.max(c.high, prev.high), rsi };
  }
  if (rsi <= 25 && c.close > prev.high && c.close > c.open && prev.close <= prev2.high) {
    return { side: 'LONG', kind: 'exhaustion', time: c.time, level: prev.high, extreme: Math.min(c.low, prev.low), rsi };
  }
  return null;
}

// Every reversal on CLOSED bars — the last bar is still forming and can un-print
// a sweep before it closes, so it is never marked.
export function findReversals(candles, lookback = REVERSAL_LOOKBACK) {
  const out = [];
  for (let i = 0; i < (candles?.length ?? 0) - 1; i++) {
    const r = reversalAt(candles, i, lookback);
    if (r) out.push(r);
  }
  return out;
}

// The setup a signal may act on: a reversal on one of the last `within` closed
// bars that price has not already invalidated by trading through its extreme.
export function latestReversal(candles, price, within = 3) {
  const n = candles?.length ?? 0;
  for (let i = n - 2; i >= Math.max(0, n - 1 - within); i--) {
    const r = reversalAt(candles, i);
    if (!r) continue;
    const intact = r.side === 'SHORT' ? price < r.extreme : price > r.extreme;
    return intact ? r : null;
  }
  return null;
}

export const reversalLabel = (r) => (r
  ? `${r.side === 'SHORT' ? 'Bearish' : 'Bullish'} ${r.kind === 'sweep' ? 'liquidity-sweep' : 'RSI-exhaustion'} reversal`
  : '');
