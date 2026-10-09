import { useEffect, useMemo, useState } from 'react';
import {
  User, SlidersHorizontal, CandlestickChart, Sparkles, Search, Eye, EyeOff,
  Save, RotateCcw, Check, Activity, Download,
} from 'lucide-react';
import { engine } from '../data/marketEngine';
import { UNIVERSE, GROUPS, AI_PROVIDERS, loadSettings, saveSettings, resetSettings } from '../data/settings';
import { testTvConnection, subscribeTvStatus, getTvStatus } from '../data/tvClient';
import { aiProviderOf, aiAuthHeaders } from '../utils/ai';

export default function SettingsPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [showAiKey, setShowAiKey] = useState(false);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsHint, setModelsHint] = useState(null);
  const [aiTest, setAiTest] = useState(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [tvStatus, setTvStatus] = useState(() => getTvStatus());
  const [tvTest, setTvTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => subscribeTvStatus(setTvStatus), []);
  const [selected, setSelected] = useState(() => new Set(settings.pairs));
  const [resetArmed, setResetArmed] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const grouped = useMemo(() => {
    const q = query.trim().toUpperCase();
    const filtered = q ? UNIVERSE.filter((d) => d.symbol.includes(q) || d.base.includes(q)) : UNIVERSE;
    return GROUPS.map((g) => ({ group: g, items: filtered.filter((d) => d.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  const setField = (k) => (e) => setSettings({ ...settings, [k]: e.target.value });

  const togglePair = (sym) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) {
        if (next.size === 1) return prev;
        next.delete(sym);
      } else next.add(sym);
      return next;
    });
  };

  const groupAll = (items, on) => {
    setSelected((prev) => {
      const next = new Set(prev);
      items.forEach((d) => (on ? next.add(d.symbol) : next.delete(d.symbol)));
      if (next.size === 0) return prev;
      return next;
    });
  };

  const savePreferences = () => {
    const risk = Math.min(100, Math.max(0.1, +settings.riskPerTrade || 1));
    saveSettings({ riskPerTrade: risk, defaultPair: settings.defaultPair });
    setSettings((s) => ({ ...s, riskPerTrade: risk }));
    notify('Trading preferences saved');
  };

  const saveTv = () => {
    saveSettings({
      tvEnabled: !!settings.tvEnabled,
      tvBackendUrl: settings.tvBackendUrl.trim() || 'http://localhost:5178',
    });
    setSettings((s) => ({ ...s, tvBackendUrl: s.tvBackendUrl.trim() || 'http://localhost:5178' }));
    notify('TradingView feed settings saved');
  };

  const testTv = async () => {
    setTesting(true);
    setTvTest(null);
    const result = await testTvConnection(settings.tvBackendUrl);
    setTvTest(result);
    setTesting(false);
  };

  const provider = aiProviderOf(settings);
  const prov = AI_PROVIDERS[provider];

  const switchProvider = (p) => {
    if (p === provider) return;
    const cur = settings.aiModel.trim();
    // Only swap the model when it's still the other provider's default — a
    // user-typed model is kept.
    const keepModel = cur && cur !== AI_PROVIDERS[provider].model && cur !== 'gpt-4o-mini';
    setSettings({
      ...settings,
      aiProvider: p,
      aiBaseUrl: AI_PROVIDERS[p].base,
      aiModel: keepModel ? cur : AI_PROVIDERS[p].model,
    });
    setOllamaModels([]);
    setModelsHint(null);
    setAiTest(null);
  };

  const fetchOllamaModels = async () => {
    setFetchingModels(true);
    setModelsHint(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/models`);
      if (!res.ok) throw new Error(`responded ${res.status}`);
      const data = await res.json();
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
      setOllamaModels(ids);
      setModelsHint(ids.length
        ? { ok: true, msg: `${ids.length} model${ids.length === 1 ? '' : 's'} installed (${Math.round(performance.now() - t0)} ms)` }
        : { ok: false, msg: `Ollama is reachable but no models are installed — run: ollama pull ${AI_PROVIDERS.ollama.model}` });
    } catch (err) {
      setModelsHint({
        ok: false,
        msg: `Ollama not reachable at ${settings.aiBaseUrl} — is it running? Start it with: ollama serve (${err.message})`,
      });
    } finally {
      setFetchingModels(false);
    }
  };

  const testAi = async () => {
    setAiTesting(true);
    setAiTest(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(settings) },
        body: JSON.stringify({
          model: settings.aiModel.trim() || prov.model,
          temperature: 0,
          max_tokens: 200,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        }),
      });
      if (!res.ok) throw new Error(`responded ${res.status}`);
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content ?? '').trim().slice(0, 60);
      setAiTest({ ok: true, msg: `${settings.aiModel.trim() || prov.model} replied "${text || '(empty)'}" in ${((performance.now() - t0) / 1000).toFixed(1)} s` });
    } catch (err) {
      setAiTest({ ok: false, msg: `${settings.aiModel.trim() || prov.model} test failed — ${err.message}. ${provider === 'ollama' ? 'Is Ollama running with this model pulled?' : 'Check the base URL and API key.'}` });
    } finally {
      setAiTesting(false);
    }
  };

  const saveAiModel = () => {
    saveSettings({
      aiProvider: provider,
      aiApiKey: settings.aiApiKey.trim(),
      aiModel: settings.aiModel.trim() || prov.model,
      aiBaseUrl: settings.aiBaseUrl.trim() || prov.base,
    });
    notify('AI model settings saved');
  };

  const savePairs = () => {
    engine.applyUniverse([...selected]);
    saveSettings({ pairs: [...selected] });
    notify(`Instrument universe updated — ${selected.size} enabled`);
  };

  const doReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      setTimeout(() => setResetArmed(false), 3000);
      return;
    }
    const fresh = resetSettings();
    setSettings(fresh);
    setSelected(new Set(fresh.pairs));
    engine.applyUniverse(fresh.pairs);
    setResetArmed(false);
    notify('Settings reset to defaults');
  };

  return (
    <div className="page settings-page">
      <section className="panel profile-card rise">
        <div className="profile-avatar"><User size={24} /></div>
        <div>
          <div className="profile-name">{settings.profileName}</div>
          <div className="profile-email">{settings.profileEmail}</div>
        </div>
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '60ms' }}>
        <div className="panel-head">
          <span className="panel-title"><SlidersHorizontal size={14} /> Trading Preferences</span>
        </div>
        <div className="field">
          <label>Default Risk Per Trade (%)</label>
          <input className="inp" type="number" min="0.1" max="100" step="0.1"
            value={settings.riskPerTrade} onChange={setField('riskPerTrade')} />
        </div>
        <div className="field">
          <label>Default Trading Pair</label>
          <select className="inp" value={settings.defaultPair} onChange={setField('defaultPair')}>
            {UNIVERSE.map((d) => <option key={d.symbol} value={d.symbol}>{d.symbol}</option>)}
          </select>
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={savePreferences}><Save size={14} /> Save Settings</button>
          <button className={`btn ${resetArmed ? 'warn' : 'ghost'}`} onClick={doReset}>
            <RotateCcw size={14} /> {resetArmed ? 'Click again to confirm reset' : 'Reset to defaults'}
          </button>
        </div>
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '120ms' }}>
        <div className="panel-head">
          <span className="panel-title"><CandlestickChart size={14} /> TradingView Realtime Data</span>
          <span className={`tv-pill ${tvStatus.state === 'open' ? 'on' : ''}`}>
            <span className="tv-dot" />
            {tvStatus.state === 'open' ? 'Live' : tvStatus.state === 'connecting' ? 'Connecting…'
              : tvStatus.state === 'closed' ? 'Reconnecting…' : tvStatus.state === 'error' ? 'Error' : 'Off'}
          </span>
        </div>
        <p className="section-desc">
          Streams live quotes and 1-minute candles from TradingView through the bundled bridge server —
          no API key required. Start it alongside the app with <code>npm run dev</code> (or separately with{' '}
          <code>npm run dev:tv</code>).
        </p>
        <label className={`pair-check tv-toggle${settings.tvEnabled ? ' on' : ''}`}>
          <input
            type="checkbox"
            checked={!!settings.tvEnabled}
            onChange={(e) => setSettings({ ...settings, tvEnabled: e.target.checked })}
          />
          Enable realtime TradingView feed
        </label>
        <div className="field">
          <label>Bridge server URL</label>
          <input
            className="inp"
            placeholder="http://localhost:5178"
            value={settings.tvBackendUrl}
            onChange={setField('tvBackendUrl')}
          />
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={saveTv}><Save size={14} /> Save Feed Settings</button>
          <button className="btn ghost" onClick={testTv} disabled={testing}>
            <Activity size={14} /> {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
        {tvTest && (
          <span className={`field-hint ${tvTest.ok ? 'ok' : 'bad'}`}>
            {tvTest.ok
              ? `Bridge reachable in ${tvTest.ms} ms — realtime data flowing.`
              : `Connection failed (${tvTest.ms} ms) — is the bridge running? (${tvTest.error ?? 'no response'})`}
          </span>
        )}
        {tvStatus.state === 'open' && (
          <span className="field-hint ok">Feed connected — charts, signals and prices use live TradingView data.</span>
        )}
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '180ms' }}>
        <div className="panel-head">
          <span className="panel-title"><Sparkles size={14} /> AI Model Integration</span>
          <span className="panel-sub">{prov.label}</span>
        </div>
        <p className="section-desc">
          Call a cloud OpenAI-compatible endpoint with your own API key, or run a local model through
          Ollama — free and private, no key needed.
        </p>
        <div className="pills ai-provider-pills">
          {Object.entries(AI_PROVIDERS).map(([id, p]) => (
            <button key={id} className={`pill${provider === id ? ' active' : ''}`} onClick={() => switchProvider(id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="field">
          <label>Model</label>
          <input
            className="inp"
            list="ai-model-options"
            placeholder={prov.model}
            value={settings.aiModel}
            onChange={setField('aiModel')}
          />
          <datalist id="ai-model-options">
            {provider === 'ollama' && ollamaModels.map((m) => <option key={m} value={m} />)}
          </datalist>
          <span className="field-hint">
            {provider === 'ollama'
              ? `Use any model you've pulled with ollama. Default: ${AI_PROVIDERS.ollama.model}`
              : 'Any OpenAI-compatible chat model id, e.g. gpt-4o-mini, deepseek-chat.'}
          </span>
        </div>
        {prov.keyRequired ? (
          <div className="field">
            <label>API Key</label>
            <div className="inp-wrap">
              <input
                className="inp"
                type={showAiKey ? 'text' : 'password'}
                placeholder="sk-xxxxxxxxxxxxxxxx"
                value={settings.aiApiKey}
                onChange={setField('aiApiKey')}
              />
              <button className="inp-eye" onClick={() => setShowAiKey(!showAiKey)} type="button">
                {showAiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        ) : (
          <span className="field-hint ok">
            Runs locally via Ollama — no API key, requests never leave this machine.
            Start the server with <code>ollama serve</code>. Note: text-only local models can't read screenshots.
          </span>
        )}
        <div className="field">
          <label>Base URL (OpenAI-compatible)</label>
          <input className="inp" placeholder={prov.base} value={settings.aiBaseUrl} onChange={setField('aiBaseUrl')} />
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={saveAiModel}><Save size={14} /> Save AI Settings</button>
          {provider === 'ollama' && (
            <button className="btn ghost" onClick={fetchOllamaModels} disabled={fetchingModels}>
              <Download size={14} /> {fetchingModels ? 'Fetching…' : 'Fetch installed models'}
            </button>
          )}
          <button className="btn ghost" onClick={testAi} disabled={aiTesting}>
            <Activity size={14} /> {aiTesting ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {modelsHint && <span className={`field-hint ${modelsHint.ok ? 'ok' : 'bad'}`}>{modelsHint.msg}</span>}
        {aiTest && <span className={`field-hint ${aiTest.ok ? 'ok' : 'bad'}`}>{aiTest.msg}</span>}
        <span className="field-hint">
          {prov.keyRequired
            ? (settings.aiApiKey
              ? 'News desk, strategies and screenshot analysis will call your model for real analysis. Keys stay in this browser only.'
              : 'Leave empty to keep the built-in simulated analysis engines.')
            : 'News desk and strategy analysis will call your local model — no key needed.'}
        </span>
      </section>

      <section className="panel settings-section rise" style={{ animationDelay: '240ms' }}>
        <div className="panel-head">
          <span className="panel-title">Instruments Universe</span>
          <span className="panel-sub">{selected.size} of {UNIVERSE.length} enabled</span>
        </div>
        <div className="inp-wrap search-settings">
          <Search size={14} />
          <input className="inp" placeholder="Search pairs, indices, stocks…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="groups">
          {grouped.map(({ group, items }) => {
            const enabledCount = items.filter((d) => selected.has(d.symbol)).length;
            return (
              <div key={group} className="group-block">
                <div className="group-head">
                  <b>{group}</b>
                  <span className="dim">{enabledCount}/{items.length}</span>
                  <button className="btn ghost sm" onClick={() => groupAll(items, true)}>All</button>
                  <button className="btn ghost sm" onClick={() => groupAll(items, false)}>None</button>
                </div>
                <div className="group-grid">
                  {items.map((d) => (
                    <label key={d.symbol} className={`pair-check${selected.has(d.symbol) ? ' on' : ''}`}>
                      <input type="checkbox" checked={selected.has(d.symbol)} onChange={() => togglePair(d.symbol)} />
                      {d.symbol}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={savePairs}><Check size={14} /> Save &amp; apply universe</button>
        </div>
      </section>

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
