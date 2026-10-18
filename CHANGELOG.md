# Changelog

All notable changes to FxOrbit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is versioned by
date and commit while it stays pre-1.0.

## 2026-10-18 — Full QA and security pass

A professional QA pass over the bridge server, the market engine, the chart and both
storage layers: 24 defects found, fixed and regression-tested. Gate at push: oxlint
0 warnings / 0 errors, 143 tests (up from 119), `vite build` clean.

Commits: `153d4db` (bridge), `d99c83b` (engine, chart, storage), `8052012` (network).

### Security

- **The trade archive is no longer readable or writable from any web page.** Every
  endpoint answered `Access-Control-Allow-Origin: *` while the bridge bound `::`
  (all interfaces), so any site opened in the user's browser could fetch the full
  trade history or `POST` overwrites to it. Responses now echo a CORS header only for
  a local page origin.
- **DNS rebinding is blocked.** A rebinding attack arrives *from* `127.0.0.1`, so the
  peer check alone could not catch it; the `Host` header must now be a loopback name.
- **The bridge can no longer be crashed by a malformed request.** A bad `Host` header
  threw inside the async request handler — an unhandled rejection that killed the
  process, and `concurrently -k` then took the Vite dev server down with it. Requests
  are parsed defensively and handled behind a catch that answers 500.
- **Prototype-chain lookups removed.** `?tf=constructor` passed validation and
  `symbol=__proto__` returned `Object.prototype` where a symbol string was expected;
  all client-keyed lookups go through `hasOwn`.
- **WebSocket resource exhaustion bounded.** A single subscribe message could name
  thousands of symbols and open one TradingView session each — from any origin, since
  WebSockets are not CORS-gated. Subscriptions are now capped (40 symbols × 6
  timeframes), deduplicated, and applied one at a time so back-to-back messages can no
  longer orphan watchers.
- Hardening: 15s timeouts on every upstream news/RSS fetch, `X-Content-Type-Options:
  nosniff` and `Cache-Control: no-store` on all responses, a row cap on
  `POST /api/trades`, graceful `SIGINT`/`SIGTERM` shutdown that releases the port and
  the connection pool.
- Audited and found clean: all SQL is parameterized (no injection), no XSS sinks
  (no `innerHTML`/`dangerouslySetInnerHTML` anywhere), no credentials in code or logs.

### Fixed

- **The Charts page froze the entire terminal.** The 1-minute candle was streamed into
  whatever timeframe was displayed: on 15m it appended a bogus intraday bar every
  tick, then threw `Cannot update oldest data` from inside the engine's listener loop,
  which silently stopped every later subscriber — all pages and the topbar — from
  receiving prices. The chart now streams the displayed timeframe's own last bar.
- `engine.emit()` isolates a listener that throws, so one broken page can no longer
  silence the rest of the app.
- **A NULL column in the archive white-screened History, Portfolio, Dashboard and the
  News book.** Open trades legitimately have NULL `exit`/`pips`/`pnl`/`closed_at` and
  there was no error boundary at all; restored rows are coerced at load.
- **Pip size was guessed as `0.0001`** whenever a trade's pair had no live state —
  100× wrong for JPY crosses, 10 000× for DOGE. It now reads the universe catalog.
- **Switching an instrument off orphaned its open trade forever** (exits are only
  checked for live states) and later booked it at $0. It is now closed at the last
  price with reason "Pair disabled".
- `loadSettings` let a stored `null` override a default the pages dereference
  (`profileName.split`, `aiBaseUrl.replace`); stored values are validated by type and
  unknown keys are dropped.
- A signal-book entry without levels crashed the Signals page and could never be
  scored, so it stayed "active" forever. Malformed entries are discarded.
- `engine.start()` never emitted, so a hard reload rendered an empty chart for ~900 ms
  and a Generate button that silently did nothing.
- **Simulated candles ran ~8× faster than the clock** and painted bars minutes in the
  future while the bar countdown disagreed with them; they now roll on their own epoch
  boundary.
- **Armed strategies traded dead configuration.** The executor read
  `fastEma`/`slowEma`/`rsiFilter`/`slPips`/`tpPips`/`direction` — fields no UI can
  write — so every book used a hardcoded 12-pip stop and 24-pip target on every
  instrument (0.015% of price on BTC, stopped out by noise) and both directions were
  always allowed. It now uses the same volatility-derived levels as the signal desk and
  honours the direction the book's own rules describe.
- **Settings → "Risk Per Trade (%)" was decorative**; position sizing hardcoded 1%. It
  now reads the setting, clamped to 0.1–10%.
- A hung request permanently wedged a surface: News Refresh, the Signals busy flag and
  the trade-sync guard that never releases while a promise is pending. Every JSON call
  now has a deadline (bridge 10s, AI 5 min for a cold local-model load).
- `fetchTvHistory` parsed the body before checking `res.ok`, so a 502 HTML error page
  threw a misleading `SyntaxError` instead of the real reason.
- The AI base URL is scheme-validated before the `Authorization` header is attached, so
  a mistyped value can neither leak the key nor be fetched at an unexpected scheme.
- The Settings page fired `GET /models` on **every keystroke** in the AI base-URL
  field; the first check is debounced and the interval is re-armed.
- The News screenshot upload used a `FileReader` with no `onerror`, so an unreadable
  file hung the upload forever; it uses the shared `readFile()` now.
- Toast timers are tracked in a ref — a second message is no longer cut short by the
  first one's timer (placing a trade then immediately closing it showed nothing).
- Removing the signal price lines no longer touches an already-destroyed chart.

### Added

- `server/security.js` — access-control rules, safe URL parsing and subscribe-payload
  bounds, unit-tested in `tests/serverSecurity.test.js`.
- `server/feed.js` — symbol/timeframe mapping and candle serialization extracted from
  the bridge so they are testable without starting a server.
- `src/utils/http.js` — one `fetchJson()` with a deadline and a body that can never be
  half-parsed; all client JSON requests go through it.
- A page-level error boundary: a render failure now names what broke instead of
  blanking the window.
- 24 regression tests across `tests/serverSecurity.test.js`,
  `tests/settingsStore.test.js`, `tests/signalBookStore.test.js` and
  `tests/marketEngine.test.js`.

### Changed — behaviour to know about

- **The bridge no longer answers another machine on the network.** Start it with
  `TV_ALLOW_LAN=1` to share it deliberately.
- **Position sizes double for a funded account**, because the stored 2% Risk Per Trade
  is honoured instead of the old hardcoded 1%. A negative-equity book still floors at
  0.01 lots, so nothing changes until Initial Balance is raised in Portfolio.
- `/api/candles` returns at most 320 bars for any requested `count`, matching what it
  actually served before.

## Earlier on 2026-10-18

- Added a crypto universe (BTC, ETH, SOL, BNB, XRP, DOGE, ADA) that trades 24/7, with
  per-symbol market-close rules instead of one global weekend gate (`867a0b1`).
- The Signals desk is restricted to crypto pairs over the weekend: FX and index pairs
  are disabled with a "market closed" note and a banner explains the reopen time
  (`65c7041`).
- Fixed chart stat tiles colliding at narrow widths, and duplicate Ollama model keys
  causing ~100 React warnings (`ccc4ad9`).
- The Trading Sessions page shows the weekend closure across its clock, session cards
  and kill zones (`518ed35`).
