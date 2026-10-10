// ── FxOrbit simulated market engine ──────────────────────────────────────────
// Generates realistic candle history per pair and streams live ticks via a
// tiny pub/sub. Data is simulated client-side; anchors sit near real market
// levels so the terminal feels alive without an API key.

import { UNIVERSE, loadSettings, saveSettings, loadStrategies } from './settings';

export const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D'];

const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '4H': 240, '1D': 1440 };

const CCY_COLORS = {
  EUR: ['#3b82f6', '#6366f1'], USD: ['#10b981', '#0d9488'], GBP: ['#8b5cf6', '#d946ef'],
  JPY: ['#f43f5e', '#fb7185'], CHF: ['#ef4444', '#f59e0b'], AUD: ['#f59e0b', '#f97316'],
  NZD: ['#eab308', '#ca8a04'], CAD: ['#dc2626', '#f97316'], XAU: ['#fbbf24', '#d97706'],
  XAG: ['#94a3b8', '#64748b'],
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
    if (!this.timer) this.timer = setInterval(() => this.tick(), 900);
  }
  applyUniverse(symbols) {
    const next = new Set(symbols);
    for (const sym of [...this.states.keys()]) {
      if (!next.has(sym)) this.states.delete(sym);
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

    const score =
      (s.rsi > 65 ? 2 : s.rsi > 55 ? 1 : 0) +
      (s.rsi < 35 ? -2 : s.rsi < 45 ? -1 : 0) +
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
    const roll = this.tickCount % 8 === 0;
    for (const s of this.states.values()) {
      if (s.tv) {
        // Price is driven by the TradingView feed; tick() only runs the
        // trade/strategy bookkeeping on top of the realtime candles.
        this.refreshIndicators(s);
        this.checkTradeExits(s);
        this.maybeAutoTrade(s);
        if (roll) this.checkStrategies(s);
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
        if (roll) {
          arr.push({
            time: last.time + TF_MINUTES[tf] * 60,
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

      this.checkTradeExits(s);
      this.maybeAutoTrade(s);
      if (roll) this.checkStrategies(s);
    }
    this.emit();
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

  // Sim → live transition for one symbol: rebase open trades by the price gap
  // so the book stays continuous instead of instantly hitting stops or booking
  // an absurd jump in P&L purely because the feed repriced the symbol.
  enterLive(s, newMid) {
    if (s.tv || !(newMid > 0) || !(s.mid > 0)) return;
    const factor = newMid / s.mid;
    for (const t of this.trades) {
      if (t.status !== 'open' || t.symbol !== s.symbol) continue;
      t.entry *= factor;
      t.sl *= factor;
      t.tp *= factor;
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
    if (tf === '1m') {
      const prev = s.liveCandle?.close;
      const last = deduped[deduped.length - 1];
      this.enterLive(s, last.close);
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
    this.enterLive(s, +candle.close);
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
    const prev = s.liveCandle?.close;
    s.dir = prev != null && c.close > prev ? 1 : c.close < prev ? -1 : 0;
    s.mid = c.close;
    s.dayHigh = Math.max(s.dayHigh, c.high);
    s.dayLow = Math.min(s.dayLow, c.low);
    s.spark.push(c.close);
    if (s.spark.length > 90) s.spark.shift();
    this.refreshIndicators(s);
    this.derive(s);
    this.checkTradeExits(s);
    this.maybeAutoTrade(s);
    this.scheduleEmit();
  }

  applyTvTick(symbol, tick) {
    const s = this.states.get(symbol);
    if (!s || tick.price == null) return;
    this.enterLive(s, tick.price);
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
    }
    if (tick.bid != null) s.bid = tick.bid;
    if (tick.ask != null) s.ask = tick.ask;
    if (tick.change != null) s.change = tick.change;
    if (tick.changePct != null) s.changePct = tick.changePct;
    s.tv = true;
    this.checkTradeExits(s);
    this.scheduleEmit();
  }

  emit() {
    const snap = [...this.states.values()];
    this.listeners.forEach((fn) => fn(snap, this.tickCount));
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
    if (s.rsi >= 65) reasons.push(`RSI ${s.rsi.toFixed(0)} overbought — momentum stretched`);
    else if (s.rsi >= 55) reasons.push(`RSI ${s.rsi.toFixed(0)} bullish momentum`);
    else if (s.rsi <= 35) reasons.push(`RSI ${s.rsi.toFixed(0)} oversold — downside pressure`);
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
  loadTrades(rows) {
    const incoming = (rows ?? []).filter((r) => r?.id && r.symbol && r.side && r.status);
    if (!incoming.length) return 0;
    const byId = new Map();
    for (const r of incoming) {
      byId.set(r.id, {
        ...r,
        lots: r.lots ?? 0.1,
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

  openTrade({ symbol, side, source = 'Manual', strategyId = null, slPips, tpPips, note = null }) {
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
      symbol, side, lots: 0.1, entry, sl, tp,
      openedAt: Date.now(), openTick: this.tickCount,
      source, strategyId, status: 'open', note,
    };
    this.trades.unshift(trade);
    return trade;
  }

  closeTrade(t, exit, reason) {
    if (t.status !== 'open') return;
    const s = this.states.get(t.symbol);
    t.status = 'closed';
    t.exit = exit;
    t.closedAt = Date.now();
    const dir = t.side === 'BUY' ? 1 : -1;
    t.pips = +(((exit - t.entry) * dir) / (s ? s.pip : 0.0001)).toFixed(1);
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
      else if (this.tickCount - t.openTick > 240) this.closeTrade(t, s.mid, 'Time Stop');
    }
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

  checkStrategies(s) {
    if (!this.strategies.length) return;
    const m1 = s.candlesByTf.get('1m');
    const closes = m1.map((c) => c.close);
    if (closes.length < 30) return;
    const hour = new Date().getUTCHours();
    for (const st of this.strategies) {
      if (!st.armed) continue;
      if (st.pair !== s.symbol) continue;
      if (this.strategyOpen.has(`${st.id}:${s.symbol}`)) continue;

      const fast = emaSeries(closes, st.fastEma ?? 9);
      const slow = emaSeries(closes, st.slowEma ?? 21);
      const f0 = fast[fast.length - 2], f1 = fast[fast.length - 1];
      const w0 = slow[slow.length - 2], w1 = slow[slow.length - 1];
      const crossUp = f0 <= w0 && f1 > w1;
      const crossDown = f0 >= w0 && f1 < w1;
      const wantLong = st.direction !== 'short';
      const wantShort = st.direction !== 'long';

      let side = null;
      if (crossUp && wantLong) side = 'BUY';
      else if (crossDown && wantShort) side = 'SELL';
      if (!side) continue;

      if (st.rsiFilter) {
        const rsi = calcRsi(closes);
        if (side === 'BUY' && rsi < (st.rsiMin ?? 40)) continue;
        if (side === 'SELL' && rsi > (st.rsiMax ?? 60)) continue;
      }
      void hour;
      const t = this.openTrade({
        symbol: s.symbol, side, source: 'Strategy', strategyId: st.id,
        slPips: st.slPips ?? 12, tpPips: st.tpPips ?? 24,
      });
      if (t) this.strategyOpen.set(`${st.id}:${s.symbol}`, t.id);
    }
  }

  getTrades() {
    return this.trades;
  }

  tradeStats() {
    const closed = this.trades.filter((t) => t.status === 'closed');
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
