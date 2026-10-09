// ── FxOrbit TradingView feed client ──────────────────────────────────────────
// Talks to the local TV bridge (server/index.js) over WebSocket: 1-minute
// candles + quotes stream into the market engine, replacing the simulated
// random walk for subscribed symbols. Higher timeframes are backfilled on
// demand via the REST endpoint (see PriceChart).

import { engine } from './marketEngine';
import { loadSettings } from './settings';

let ws = null;
let retryTimer = null;
let attempts = 0;
let currentKey = '';
let status = { state: 'idle' }; // idle | connecting | open | closed | error
const listeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export function getTvStatus() {
  return status;
}

export function subscribeTvStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export async function testTvConnection(baseUrl) {
  const target = `${(baseUrl || '').replace(/\/$/, '')}/api/status`;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok !== false, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + ingest full history for one symbol/timeframe (chart backfill).
export async function fetchTvHistory(baseUrl, symbol, tf) {
  const target = `${(baseUrl || '').replace(/\/$/, '')}/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&count=300`;
  const res = await fetch(target);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  engine.applyTvHistory(symbol, tf, body.candles);
  return body.candles.length;
}

function teardown() {
  clearTimeout(retryTimer);
  retryTimer = null;
  attempts = 0;
  currentKey = '';
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  }
}

function disconnect() {
  teardown();
  engine.markAllTv(false);
  setStatus({ state: 'idle' });
}

function connect(baseUrl, symbols, key) {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
  setStatus({ state: 'connecting', url: baseUrl });
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    setStatus({ state: 'error', error: 'Invalid bridge URL' });
    return;
  }
  ws = socket;

  socket.onopen = () => {
    attempts = 0;
    setStatus({ state: 'open', url: baseUrl });
    socket.send(JSON.stringify({ type: 'subscribe', symbols, tfs: ['1m'] }));
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'history') {
      engine.applyTvHistory(msg.symbol, msg.tf, msg.candles);
    } else if (msg.type === 'candle') {
      engine.applyTvCandle(msg.symbol, msg.tf, msg.candle);
    } else if (msg.type === 'tick') {
      engine.applyTvTick(msg.symbol, msg);
    } else if (msg.type === 'error') {
      if (msg.symbol) engine.setTvLive(msg.symbol, false);
      setStatus({ state: 'open', url: baseUrl, lastError: msg.message });
    }
  };

  socket.onerror = () => {
    setStatus({ state: 'error', url: baseUrl, error: 'Connection failed' });
  };

  socket.onclose = () => {
    if (ws !== socket) return; // superseded by a newer connect/disconnect
    engine.markAllTv(false);
    setStatus({ state: 'closed', url: baseUrl });
    attempts += 1;
    const delay = Math.min(10000, 1000 * 2 ** Math.min(attempts - 1, 4));
    retryTimer = setTimeout(() => {
      if (currentKey === key) connect(baseUrl, symbols, key);
    }, delay);
  };
}

// Reconcile the feed with current settings + enabled universe. Called on
// startup and on every settings change; cheap to call repeatedly.
export function syncTvFeed() {
  const settings = loadSettings();
  const symbols = engine.getSnapshot().map((s) => s.symbol);
  const enabled = !!settings.tvEnabled && symbols.length > 0;
  const baseUrl = (settings.tvBackendUrl || 'http://localhost:5178').trim();
  const key = `${enabled}|${baseUrl}|${symbols.join(',')}`;

  if (!enabled) {
    if (currentKey || ws) disconnect();
    return;
  }
  if (key === currentKey) return;
  teardown();
  currentKey = key;
  connect(baseUrl, symbols, key);
}
