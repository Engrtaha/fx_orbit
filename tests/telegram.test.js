import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['XAU/USD'] });
const mod = await import('../src/data/telegram.js');

const sig = {
  id: 'SIG-T1', symbol: 'XAU/USD', side: 'SHORT', tf: '15m', entry: 2400, sl: 2410, tp: 2355,
  decimals: 2, rr: 4.5, confidence: 70, expiresAt: Date.now() + 6 * 3600e3,
  strategyRules: { name: 'Liquidity Sweep Reversal' },
};

const setSettings = (patch) => localStorage.setItem('fxorbit-settings', JSON.stringify(patch));
const okReply = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

describe('alertText', () => {
  it('reads like a desk alert with the numbers a trader needs', () => {
    const t = mod.alertText(sig);
    expect(t).toContain('XAU/USD SHORT');
    expect(t).toContain('Entry 2,400.00');
    expect(t).toContain('SL 2,410.00 · TP 2,355.00');
    expect(t).toContain('R:R 1:4.5');
    expect(t).toContain('Strategy: Liquidity Sweep Reversal');
    expect(t).toContain('Expires in 6h');
  });
});

describe('notifyNewSignal', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return okReply({ message_id: 1 });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stays silent while alerts are switched off', async () => {
    setSettings({ telegramEnabled: false, telegramToken: '123:abc', telegramChatId: '42' });
    expect(await mod.notifyNewSignal(sig)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('stays silent when the per-signal option is off', async () => {
    setSettings({
      telegramEnabled: true, telegramToken: '123:abc', telegramChatId: '42', telegramNotifySignals: false,
    });
    expect(await mod.notifyNewSignal(sig)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('posts the alert once and logs the delivery', async () => {
    setSettings({
      telegramEnabled: true, telegramToken: '123:abc', telegramChatId: '-1001', telegramNotifySignals: true,
    });
    const entry = await mod.notifyNewSignal(sig);
    expect(entry.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(calls[0].init.body.get('chat_id')).toBe('-1001');
    expect(calls[0].init.body.get('text')).toContain('XAU/USD SHORT');
    expect(mod.alertLog()[0].signalId).toBe('SIG-T1');
    // The same booking must not be delivered twice.
    expect(await mod.notifyNewSignal(sig)).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('records a Telegram refusal instead of throwing', async () => {
    setSettings({
      telegramEnabled: true, telegramToken: '123:abc', telegramChatId: '42', telegramNotifySignals: true,
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    }));
    const entry = await mod.notifyNewSignal({ ...sig, id: 'SIG-T2' });
    expect(entry.ok).toBe(false);
    expect(entry.error).toContain('chat not found');
    expect(mod.alertLog()[0].ok).toBe(false);
  });
});
