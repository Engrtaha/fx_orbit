// ── Client fetch helper ──────────────────────────────────────────────────────
// A request that never answers is worse than one that fails: several surfaces
// disable their own button while a call is in flight, and the trade sync refuses
// to run again until the previous one settles — so a wedged bridge or AI backend
// used to leave the page stuck on "Analyzing…" for the rest of the session.
// Every JSON call goes through here so it has a deadline and can never hand the
// caller a half-parsed body.

export const BRIDGE_TIMEOUT_MS = 10_000;

// Local models load on demand: a cold first reply on this machine takes minutes,
// so the AI deadline is long — long enough for a legitimate load, short enough
// that a wedged backend cannot hold a page busy forever.
export const AI_TIMEOUT_MS = 300_000;

export async function fetchJson(url, { timeoutMs = BRIDGE_TIMEOUT_MS, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null) {
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}
