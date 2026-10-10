// ── FxOrbit PostgreSQL sync ──────────────────────────────────────────────────
// Trading stays in memory in the browser; this module mirrors the trade book to
// the bridge's PostgreSQL archive and restores it on boot, so trade history
// survives reloads instead of being regenerated. Every call degrades silently:
// an offline bridge or a stopped database must never block trading.

import { engine } from './marketEngine';
import { loadSettings } from './settings';

const SYNC_MS = 10_000;
const MAX_ROWS = 500;

const bridgeUrl = () => (loadSettings().tvBackendUrl || 'http://localhost:5178').replace(/\/+$/, '');

// Restore the archived book. Returns the row count, or null when the archive
// could not be read — a bridge that is merely down must never be told the
// browser's (possibly simulated) book is the truth.
export async function hydrateTrades() {
  try {
    const res = await fetch(`${bridgeUrl()}/api/trades?limit=${MAX_ROWS}`);
    const body = await res.json().catch(() => null);
    if (!body?.ok || !Array.isArray(body.trades)) return null;
    return engine.loadTrades(body.trades);
  } catch {
    return null;
  }
}

let syncing = false;

export async function syncTrades() {
  if (syncing) return;
  syncing = true;
  try {
    const trades = engine.getTrades().slice(0, MAX_ROWS);
    if (!trades.length) return;
    await fetch(`${bridgeUrl()}/api/trades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trades }),
    });
  } catch {
    /* bridge offline — the book stays in memory and retries on the next tick */
  } finally {
    syncing = false;
  }
}

// Read the archive back first, then keep it in step. Returns a stop function.
export function startTradeSync() {
  let timer = null;
  let hydrated = false;

  const tick = async () => {
    if (!hydrated) {
      if ((await hydrateTrades()) === null) return;
      hydrated = true;
    }
    await syncTrades();
  };

  void tick();
  timer = setInterval(() => { void tick(); }, SYNC_MS);
  return () => {
    if (timer) clearInterval(timer);
  };
}
