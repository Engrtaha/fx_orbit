import { useMemo, useState } from 'react';
import { KeyRound, CandlestickChart, Sparkles, Search, Eye, EyeOff, Save, RotateCcw, Check } from 'lucide-react';
import { engine } from '../data/marketEngine';
import { UNIVERSE, GROUPS, loadSettings, saveSettings, resetSettings } from '../data/settings';

export default function SettingsPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [showAiKey, setShowAiKey] = useState(false);
  const [showTvKey, setShowTvKey] = useState(false);
  const [query, setQuery] = useState('');
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

  const saveConnections = () => {
    saveSettings({
      tvApiKey: settings.tvApiKey.trim(),
      aiApiKey: settings.aiApiKey.trim(),
      aiModel: settings.aiModel.trim() || 'gpt-4o-mini',
      aiBaseUrl: settings.aiBaseUrl.trim() || 'https://api.openai.com/v1',
    });
    notify('Connections saved');
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
    <div className="page settings-grid">
      <section className="panel rise">
        <div className="panel-head">
          <span className="panel-title"><KeyRound size={14} /> API Connections</span>
          <span className="panel-sub">keys stay in this browser only</span>
        </div>

        <div className="field">
          <label><CandlestickChart size={12} /> TradingView API key</label>
          <div className="inp-wrap">
            <input
              className="inp"
              type={showTvKey ? 'text' : 'password'}
              placeholder="tv-xxxxxxxxxxxxxxxx"
              value={settings.tvApiKey}
              onChange={setField('tvApiKey')}
            />
            <button className="inp-eye" onClick={() => setShowTvKey(!showTvKey)} type="button">
              {showTvKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <span className="field-hint">Reserved for live TradingView data feeds &amp; screener widgets.</span>
        </div>

        <div className="field">
          <label><Sparkles size={12} /> AI model API key</label>
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
          <span className="field-hint">
            {settings.aiApiKey
              ? 'Vision analysis on the News page will call your model with uploaded screenshots.'
              : 'Leave empty to use the built-in simulated analysis engine.'}
          </span>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Model</label>
            <input className="inp" placeholder="gpt-4o-mini" value={settings.aiModel} onChange={setField('aiModel')} />
          </div>
          <div className="field">
            <label>Base URL (OpenAI-compatible)</label>
            <input className="inp" placeholder="https://api.openai.com/v1" value={settings.aiBaseUrl} onChange={setField('aiBaseUrl')} />
          </div>
        </div>

        <div className="btn-row">
          <button className="btn primary" onClick={saveConnections}><Save size={14} /> Save connections</button>
          <button className={`btn ${resetArmed ? 'warn' : 'ghost'}`} onClick={doReset}>
            <RotateCcw size={14} /> {resetArmed ? 'Click again to confirm reset' : 'Reset to defaults'}
          </button>
        </div>
      </section>

      <section className="panel rise" style={{ animationDelay: '60ms' }}>
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
        <button className="btn primary" onClick={savePairs} style={{ marginTop: 14 }}>
          <Check size={14} /> Save &amp; apply universe
        </button>
      </section>

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
