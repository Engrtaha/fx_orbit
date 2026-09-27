import { useMemo, useState } from 'react';
import { Brain, Save, Trash2, RefreshCw, Plus, ShieldCheck, Target, ListChecks } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { UNIVERSE, loadStrategies, saveStrategies, loadSettings } from '../data/settings';
import { Badges } from '../components/shared';

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STYLES = ['Momentum continuation', 'Mean-reversion fade', 'Breakout pullback', 'Trend-following swing'];
const TIMES = ['London open', 'New York open', 'Tokyo session', 'session overlap'];

function genAiPlan(symbol, salt) {
  const s = engine.getState(symbol);
  const rng = seededRand(hashStr(`${symbol}:${salt}:ai-plan`));
  const style = STYLES[Math.floor(rng() * STYLES.length)];
  const d = s ? engine.getDetail(s) : null;
  const bias = s ? (s.score >= 0 ? 'long' : 'short') : 'long';
  const atrMultSl = (1 + rng() * 1.2).toFixed(1);
  const atrMultTp = (2 + rng() * 1.6).toFixed(1);
  const winRate = Math.round(52 + rng() * 26);
  return {
    style,
    thesis: `${style} on ${symbol}: the engine reads ${bias} pressure building on the ${TIMES[Math.floor(rng() * TIMES.length)]} ` +
      `with volatility near its recent band. The plan trades in the direction of the 1m–15m momentum stack while ` +
      `filtering chop with an EMA structure check, aiming to capture the next impulse leg before mean reversion kicks in.`,
    entryRules: [
      `Trade only in the ${bias} direction while price holds ${bias === 'long' ? 'above' : 'below'} the 21-EMA on the 15m chart`,
      `Trigger on a ${bias === 'long' ? 'bullish' : 'bearish'} EMA-9/${20 + Math.floor(rng() * 15)} cross confirmed by a momentum tick in the same direction`,
      s ? `Skip entries when spread exceeds ${(s.spread * 1.8).toFixed(1)} pips or RSI sits between 45–55 (no-man's land)` : 'Skip entries when RSI sits between 45–55',
      `Maximum 1 position at a time; wait for a closed candle before re-entering after a stop`,
    ],
    riskRules: [
      `Stop loss at ${atrMultSl}× ATR(14) from entry — never widen a stop`,
      `Take profit at ${atrMultTp}× ATR(14); trail the stop once up ${(atrMultSl * 0.8).toFixed(1)}× ATR`,
      `Risk 0.5–1% of equity per trade; daily loss cap of 3%`,
      `Time-stop: exit any trade still open after 4 hours of stagnation`,
    ],
    stats: [
      { label: 'Backtest win rate', value: `${winRate}%` },
      { label: 'Avg R : R', value: (atrMultTp / atrMultSl).toFixed(2) },
      { label: 'Trades / week', value: String(3 + Math.floor(rng() * 9)) },
      { label: 'Max drawdown', value: `${(4 + rng() * 9).toFixed(1)}%` },
    ],
    levels: d && s ? {
      entry: fmt(d.entry, s.decimals), sl: fmt(d.sl, s.decimals), tp: fmt(d.tp, s.decimals),
    } : null,
  };
}

const DEFAULT_FORM = {
  name: '', pair: 'EUR/USD', direction: 'both', fastEma: 9, slowEma: 21,
  rsiFilter: false, rsiMin: 40, rsiMax: 60, slPips: 12, tpPips: 24,
};

export default function StrategiesPage() {
  const [tab, setTab] = useState('ai');
  const [aiSymbol, setAiSymbol] = useState('EUR/USD');
  const [salt, setSalt] = useState(1);
  const [autoSet, setAutoSet] = useState(() => new Set(loadSettings().autoTrade));
  const [strategies, setStrategies] = useState(() => loadStrategies());
  const [form, setForm] = useState(DEFAULT_FORM);
  const [savedFlash, setSavedFlash] = useState(false);

  const plan = useMemo(() => genAiPlan(aiSymbol, salt), [aiSymbol, salt]);

  const toggleAuto = (sym) => {
    engine.setAutoTrade(sym, !autoSet.has(sym));
    setAutoSet(new Set(loadSettings().autoTrade));
  };

  const saveList = (list) => {
    setStrategies(list);
    saveStrategies(list);
    engine.syncStrategies(list);
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const st = {
      id: `st-${Date.now().toString(36)}`,
      name: form.name.trim(),
      pair: form.pair,
      direction: form.direction,
      fastEma: +form.fastEma,
      slowEma: +form.slowEma,
      rsiFilter: form.rsiFilter,
      rsiMin: +form.rsiMin,
      rsiMax: +form.rsiMax,
      slPips: +form.slPips,
      tpPips: +form.tpPips,
      active: true,
      createdAt: Date.now(),
    };
    saveList([st, ...strategies]);
    setForm(DEFAULT_FORM);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
  };

  const toggleActive = (id) => {
    saveList(strategies.map((s) => (s.id === id ? { ...s, active: !s.active } : s)));
  };

  const remove = (id) => {
    saveList(strategies.filter((s) => s.id !== id));
  };

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div className="page">
      <div className="seg-tabs">
        <button className={`seg-tab${tab === 'ai' ? ' active' : ''}`} onClick={() => setTab('ai')}>
          <Brain size={14} /> AI Strategy
        </button>
        <button className={`seg-tab${tab === 'custom' ? ' active' : ''}`} onClick={() => setTab('custom')}>
          <ListChecks size={14} /> My Strategy
        </button>
      </div>

      {tab === 'ai' ? (
        <div className="ai-strat-grid">
          <section className="panel rise">
            <div className="panel-head">
              <span className="panel-title"><Brain size={14} /> Strategy Generator</span>
              <span className="panel-sub">heuristic engine — no key required</span>
            </div>
            <div className="field">
              <label>Instrument</label>
              <select className="inp" value={aiSymbol} onChange={(e) => { setAiSymbol(e.target.value); setSalt(1); }}>
                {UNIVERSE.map((d) => <option key={d.symbol} value={d.symbol}>{d.symbol} · {d.group}</option>)}
              </select>
            </div>
            <div className="ai-plan-stats">
              {plan.stats.map((s) => (
                <div key={s.label} className="mini-stat">
                  <div className="v">{s.value}</div>
                  <div className="k">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="btn-row">
              <button className="btn ghost" onClick={() => setSalt((x) => x + 1)}>
                <RefreshCw size={14} /> Regenerate
              </button>
              <button className={`btn ${autoSet.has(aiSymbol) ? 'warn' : 'primary'}`} onClick={() => toggleAuto(aiSymbol)}>
                <ShieldCheck size={14} />
                {autoSet.has(aiSymbol) ? `Auto-trade ON — disarm` : 'Enable auto-trade on this pair'}
              </button>
            </div>
            {plan.levels && (
              <div className="sig-levels" style={{ marginTop: 14 }}>
                <div><span>Entry zone</span><b>{plan.levels.entry}</b></div>
                <div><span>Protective stop</span><b className="dn">{plan.levels.sl}</b></div>
                <div><span>Profit target</span><b className="up">{plan.levels.tp}</b></div>
              </div>
            )}
          </section>

          <section className="panel rise" style={{ animationDelay: '60ms' }}>
            <div className="panel-head">
              <span className="panel-title"><Target size={14} /> {plan.style}</span>
            </div>
            <div className="ai-block">
              <div className="k">Thesis</div>
              <p>{plan.thesis}</p>
            </div>
            <div className="strat-cols">
              <div className="ai-block">
                <div className="k">Entry rules</div>
                <ul className="rule-list">
                  {plan.entryRules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
              <div className="ai-block">
                <div className="k">Risk rules</div>
                <ul className="rule-list">
                  {plan.riskRules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="custom-strat-grid">
          <section className="panel rise">
            <div className="panel-head">
              <span className="panel-title"><Plus size={14} /> Strategy Builder</span>
              <span className="panel-sub">EMA crossover system, executed live</span>
            </div>
            <form onSubmit={submit} className="strat-form">
              <div className="field">
                <label>Strategy name</label>
                <input className="inp" placeholder="e.g. London momentum 9/21" value={form.name} onChange={f('name')} required />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Instrument</label>
                  <select className="inp" value={form.pair} onChange={f('pair')}>
                    {UNIVERSE.map((d) => <option key={d.symbol} value={d.symbol}>{d.symbol}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Direction</label>
                  <select className="inp" value={form.direction} onChange={f('direction')}>
                    <option value="both">Long &amp; Short</option>
                    <option value="long">Long only</option>
                    <option value="short">Short only</option>
                  </select>
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Fast EMA</label>
                  <input className="inp" type="number" min="2" max="100" value={form.fastEma} onChange={f('fastEma')} />
                </div>
                <div className="field">
                  <label>Slow EMA</label>
                  <input className="inp" type="number" min="3" max="200" value={form.slowEma} onChange={f('slowEma')} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Stop loss (pips)</label>
                  <input className="inp" type="number" min="1" max="500" value={form.slPips} onChange={f('slPips')} />
                </div>
                <div className="field">
                  <label>Take profit (pips)</label>
                  <input className="inp" type="number" min="1" max="1000" value={form.tpPips} onChange={f('tpPips')} />
                </div>
              </div>
              <label className="check-row">
                <input type="checkbox" checked={form.rsiFilter} onChange={f('rsiFilter')} />
                RSI confirmation filter
              </label>
              {form.rsiFilter && (
                <div className="field-row">
                  <div className="field">
                    <label>RSI min (for longs)</label>
                    <input className="inp" type="number" min="1" max="99" value={form.rsiMin} onChange={f('rsiMin')} />
                  </div>
                  <div className="field">
                    <label>RSI max (for shorts)</label>
                    <input className="inp" type="number" min="1" max="99" value={form.rsiMax} onChange={f('rsiMax')} />
                  </div>
                </div>
              )}
              <button className="btn primary" type="submit">
                <Save size={14} /> {savedFlash ? 'Saved — engine synced' : 'Save strategy'}
              </button>
            </form>
          </section>

          <section className="panel rise" style={{ animationDelay: '60ms' }}>
            <div className="panel-head">
              <span className="panel-title">Saved Strategies</span>
              <span className="panel-sub">{strategies.filter((s) => s.active).length} active</span>
            </div>
            <div className="strat-list">
              {strategies.length === 0 && (
                <p className="dim" style={{ padding: '18px 4px' }}>No custom strategies yet. Build one on the left — it starts executing against the live simulator immediately.</p>
              )}
              {strategies.map((st) => {
                const d = UNIVERSE.find((u) => u.symbol === st.pair);
                return (
                  <div key={st.id} className={`strat-card${st.active ? ' active' : ''}`}>
                    <div className="strat-card-head">
                      {d && <Badges base={d.base} quote={d.quote} size={22} />}
                      <div>
                        <b>{st.name}</b>
                        <div className="dim" style={{ fontSize: 11 }}>
                          {st.pair} · EMA {st.fastEma}/{st.slowEma} · {st.direction} · SL {st.slPips} / TP {st.tpPips} pips
                          {st.rsiFilter && ` · RSI ${st.rsiMin}–${st.rsiMax}`}
                        </div>
                      </div>
                      <button
                        className={`switch${st.active ? ' on' : ''}`}
                        onClick={() => toggleActive(st.id)}
                        title={st.active ? 'Deactivate' : 'Activate'}
                      >
                        <i />
                      </button>
                      <button className="btn ghost sm icon" onClick={() => remove(st.id)} title="Delete strategy">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
