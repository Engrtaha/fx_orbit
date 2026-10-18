// ── Bridge access control ────────────────────────────────────────────────────
// This process holds the user's trade archive and forwards a news key upstream.
// It binds '::' so ws://localhost and ws://127.0.0.1 both resolve, which also
// puts it on every interface of the machine — so access is decided here instead
// of by the bind: loopback peers only, local page origins only, loopback Host
// only (a browser replaying an attacker domain against 127.0.0.1 gets blocked
// by the Host check even though its peer address is loopback).
// Set TV_ALLOW_LAN=1 to serve another machine on the network.

const LOOPBACK_V4 = /^127\./;
const HOST_LOCAL = /^(?:localhost|127(?:\.\d+){3}|\[?[0:]*:1\]?)(?::\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?$/i;

export const isLoopback = (addr) => {
  const a = String(addr ?? '').replace(/^::ffff:/i, '').split('%')[0];
  return LOOPBACK_V4.test(a) || a === '::1' || a === 'localhost';
};

// A missing Host never reaches this check (the request is refused first);
// anything that is not a loopback name is a rebinding or a LAN client.
export const hostAllowed = (host, allowLan = false) => (
  allowLan ? true : HOST_LOCAL.test(String(host ?? ''))
);

// Browsers always send Origin on the requests this matters for. An origin that
// is not the terminal's own gets no CORS header back, so the page can open the
// socket but can never read a response.
export const allowedOrigin = (origin) => {
  const o = String(origin ?? '').trim();
  return o && LOCAL_ORIGIN.test(o) ? o : null;
};

// A malformed or missing Host must not throw inside the request handler: an
// async handler rejection with no listener kills the process, and `concurrently
// -k` then takes the Vite dev server down with it.
export function requestUrl(reqUrl, host) {
  try {
    return new URL(reqUrl, `http://${host || 'localhost'}`);
  } catch {
    return null;
  }
}

// One subscribe message may not open an unbounded number of TradingView
// sessions from either array — both are multiplied into watchers per socket.
export const MAX_SUBSCRIBE_SYMBOLS = 40;
export const MAX_SUBSCRIBE_TFS = 6;

export function sanitizeSubscribe(msg, tfMap) {
  const symbols = [...new Set(
    (Array.isArray(msg?.symbols) ? msg.symbols : [])
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s && s.length <= 24),
  )].slice(0, MAX_SUBSCRIBE_SYMBOLS);
  const tfs = [...new Set(
    (Array.isArray(msg?.tfs) ? msg.tfs : [])
      .filter((tf) => typeof tf === 'string' && hasOwn(tfMap, tf)),
  )].slice(0, MAX_SUBSCRIBE_TFS);
  return { symbols, tfs };
}

// Plain objects inherit from Object.prototype, so `MAP[symbol]` is truthy for
// '__proto__' or 'toString' and returns an object or a function where a symbol
// string is expected. Every lookup of an attacker-supplied key goes through this.
export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
