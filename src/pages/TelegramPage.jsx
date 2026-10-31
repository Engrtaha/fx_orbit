import { useEffect, useRef, useState } from 'react';
import {
  Bot, Send, Save, Check, Eye, EyeOff, Activity, MessageSquare, Trash2,
} from 'lucide-react';
import { loadSettings, saveSettings } from '../data/settings';
import {
  telegramReady, looksLikeBotToken, botIdentity, sendTelegram, alertText,
  alertLog, clearAlertLog, subscribeTelegram,
} from '../data/telegram';
import { activeSignals, subscribeSignals } from '../data/signalEngine';

// The alert preview needs a signal even before the desk has one live, so the
// page shows exactly what would be delivered instead of an empty box.
const sampleSignal = () => ({
  symbol: 'XAU/USD', side: 'SHORT', tf: '15m', entry: 2400, sl: 2410, tp: 2355,
  decimals: 2, rr: 4.5, confidence: 70, expiresAt: Date.now() + 6 * 3600e3,
  strategyRules: { name: 'My strategy' },
});

const ago = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
};

export default function TelegramPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(null); // 'bot' | 'send'
  const [result, setResult] = useState(null);
  const [, setSigV] = useState(0);
  const [, setLogV] = useState(0);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  useEffect(() => subscribeTelegram(() => setLogV((v) => v + 1)), []);
  useEffect(() => subscribeSignals(() => setSigV((v) => v + 1)), []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const notify = (msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  // Warnings and test results describe the DRAFT; actual delivery uses the saved
  // record, so the page keeps saying when the two differ.
  const stored = loadSettings();
  const savedReady = telegramReady(stored);
  const token = settings.telegramToken.trim();
  const chatId = settings.telegramChatId.trim();
  const dirty = ['telegramEnabled', 'telegramToken', 'telegramChatId', 'telegramNotifySignals']
    .some((k) => String(settings[k] ?? '').trim() !== String(stored[k] ?? '').trim());

  const live = activeSignals();
  const preview = live[0] ?? sampleSignal();
  const log = alertLog();

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const save = () => {
    saveSettings({
      telegramEnabled: !!settings.telegramEnabled,
      telegramToken: token,
      telegramChatId: chatId,
      telegramNotifySignals: !!settings.telegramNotifySignals,
    });
    set({ telegramToken: token, telegramChatId: chatId });
    setResult(null);
    notify('Telegram alert settings saved');
  };

  const testBot = async () => {
    setBusy('bot');
    setResult(null);
    try {
      const me = await botIdentity(settings);
      setResult({
        ok: true,
        msg: `Bot @${me.username || me.name || 'unknown'} answered — the token is valid.`
          + (dirty ? ' Save the settings to start sending alerts.' : ''),
      });
    } catch (err) {
      setResult({ ok: false, msg: `Bot check failed — ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('send');
    setResult(null);
    try {
      await sendTelegram(settings, 'FxOrbit test — your Telegram alerts are wired to the trading desk.');
      setResult({ ok: true, msg: `Test message sent to chat ${chatId}.` });
    } catch (err) {
      setResult({ ok: false, msg: `Test failed — ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page settings-page telegram-page">
      <section className="panel settings-section rise">
        <div className="panel-head">
          <span className="panel-title"><Bot size={14} /> Bot connection</span>
          <span className={`tv-pill ${savedReady ? 'on' : ''}`}>
            <span className="tv-dot" />
            {savedReady ? 'Alerts on' : settings.telegramEnabled ? 'Not ready' : 'Off'}
          </span>
        </div>
        <p className="section-desc">
          Trade alerts go out through your own Telegram bot. The token stays in this browser and is
          only ever sent to <code>api.telegram.org</code> — the same handling as your AI key.
        </p>

        <label className={`pair-check tv-toggle${settings.telegramEnabled ? ' on' : ''}`}>
          <input
            type="checkbox"
            checked={!!settings.telegramEnabled}
            onChange={(e) => set({ telegramEnabled: e.target.checked })}
          />
          Enable Telegram alerts
        </label>

        <div className="field">
          <label>Bot token</label>
          <div className="inp-wrap">
            <input
              className="inp"
              type={showToken ? 'text' : 'password'}
              placeholder="123456789:AAH…"
              value={settings.telegramToken}
              onChange={(e) => set({ telegramToken: e.target.value })}
            />
            <button className="inp-eye" type="button" onClick={() => setShowToken(!showToken)}>
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {token && !looksLikeBotToken(token) && (
            <span className="field-hint">A BotFather token looks like <code>123456789:AAH…</code> — this one has an unusual shape.</span>
          )}
        </div>

        <div className="field">
          <label>Chat ID</label>
          <input
            className="inp"
            placeholder="123456789 or -1001234567890"
            value={settings.telegramChatId}
            onChange={(e) => set({ telegramChatId: e.target.value })}
          />
          <span className="field-hint">
            Your personal chat ID, or a group&apos;s (group IDs are negative). Send the bot one message
            first — a bot cannot open a chat on its own.
          </span>
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={save}><Save size={14} /> Save alert settings</button>
          <button className="btn ghost" onClick={testBot} disabled={busy !== null || !token}>
            <Activity size={14} /> {busy === 'bot' ? 'Checking…' : 'Test bot'}
          </button>
          <button className="btn ghost" onClick={sendTest} disabled={busy !== null || !token || !chatId}>
            <Send size={14} /> {busy === 'send' ? 'Sending…' : 'Send test message'}
          </button>
        </div>
        {dirty && <span className="field-hint bad">Unsaved — alerts keep using the saved token and chat until you save.</span>}
        {result && <span className={`field-hint ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</span>}
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '80ms' }}>
        <div className="panel-head">
          <span className="panel-title"><MessageSquare size={14} /> Trade signal alerts</span>
          <span className="panel-sub">
            {savedReady && stored.telegramNotifySignals ? 'watching the signal book' : 'paused'}
          </span>
        </div>
        <p className="section-desc">
          When a new signal appears on Trade Signals — generated by you or regenerated after a TP, SL or
          expiry — the desk sends entry, stop, target and R:R to your chat. One message per signal.
        </p>
        <label className={`pair-check tv-toggle${settings.telegramNotifySignals ? ' on' : ''}`}>
          <input
            type="checkbox"
            checked={!!settings.telegramNotifySignals}
            onChange={(e) => set({ telegramNotifySignals: e.target.checked })}
          />
          Notify me when a new signal appears on Trade Signals
        </label>
        {!savedReady && (
          <span className="field-hint">
            Alerts stay off until a token and chat ID are saved and the connection is enabled.
          </span>
        )}
        <div className="field">
          <label>{live.length ? `Preview — newest live signal (${live[0].symbol} ${live[0].side})` : 'Preview — sample alert'}</label>
          <pre className="tg-preview">{alertText(preview)}</pre>
        </div>
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '140ms' }}>
        <div className="panel-head">
          <span className="panel-title">Getting the token and chat ID</span>
        </div>
        <ol className="tg-steps">
          <li>In Telegram, open <b>@BotFather</b> and send <code>/newbot</code>. Pick a name, then copy the token it replies with.</li>
          <li>Open your new bot and send it any message — a bot cannot message you until you start the chat (for a group, add the bot to it).</li>
          <li>To find the ID, message <b>@userinfobot</b>, or add <b>@RawDataBot</b> to a group and read the chat ID it reports.</li>
          <li>Paste both above, enable alerts, save, then press <b>Send test message</b>.</li>
        </ol>
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '200ms' }}>
        <div className="panel-head">
          <span className="panel-title">Recent alerts</span>
          <span className="panel-sub">{log.length ? `${log.length} kept` : 'nothing sent yet'}</span>
          {log.length > 0 && (
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={clearAlertLog}>
              <Trash2 size={12} /> Clear
            </button>
          )}
        </div>
        {log.length === 0 ? (
          <p className="sig-note">
            No alerts sent yet. Generate a signal on the Trade Signals page and every delivery lands here,
            including any Telegram refusal.
          </p>
        ) : (
          <div className="tg-log">
            {log.map((e) => (
              <div className="tg-log-row" key={`${e.signalId}-${e.at}`}>
                <span className={`tg-log-dot ${e.ok ? 'ok' : 'bad'}`} />
                <b>{e.symbol} {e.side}</b>
                <span className={`tg-log-k${e.ok ? '' : ' bad'}`}>{e.ok ? 'Delivered' : e.error || 'Failed'}</span>
                <span className="tg-log-at">{ago(e.at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
