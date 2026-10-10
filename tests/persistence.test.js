import { afterEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../src/data/marketEngine';
import { hydrateTrades, startTradeSync } from '../src/data/persistence';

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hydrateTrades', () => {
  it('reports null rather than an empty book when the bridge cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await hydrateTrades()).toBeNull();
  });

  it('tells an unreachable archive apart from an archive that is merely empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, db: 'down', trades: [] })));
    expect(await hydrateTrades()).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, db: 'up', trades: [] })));
    expect(await hydrateTrades()).toBe(0);
  });
});

describe('startTradeSync', () => {
  it('never mirrors the local book over an archive it has not read back', async () => {
    engine.loadTrades([
      { id: 'T-400', symbol: 'XAU/USD', side: 'BUY', status: 'closed', lots: 0.1, entry: 3000, exit: 3010, pips: 10, pnl: 10, openedAt: 1, closedAt: 2 },
    ]);
    const posts = [];
    let archiveUp = false;

    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(opts?.method) === 'POST') {
        posts.push(String(url));
        return json({ ok: true, stored: 1 });
      }
      if (!archiveUp) throw new TypeError('Failed to fetch');
      return json({ ok: true, db: 'up', trades: [] });
    }));

    const stop = startTradeSync();
    await vi.advanceTimersByTimeAsync(30000);
    expect(posts).toEqual([]);

    archiveUp = true;
    await vi.advanceTimersByTimeAsync(15000);
    expect(posts.length).toBeGreaterThan(0);
    stop();
  });
});
