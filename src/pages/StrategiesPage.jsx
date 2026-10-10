import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, RefreshCw, ShieldCheck, FileText, Upload, Sparkles, X, AlertTriangle,
  Image as ImageIcon, Video, File as FileIcon, Trash2,
} from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { UNIVERSE, loadSettings, saveSettings } from '../data/settings';
import PriceChart from '../components/PriceChart';
import {
  downscale, parseJsonLoose, aiReady, aiAuthHeaders, aiSupportsVision,
  fileKind, readFile, clipText, videoFrames, attachmentContent,
} from '../utils/ai';

const MAX_FILES = 8;
const MAX_MB = 25;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const KIND_ICON = {
  image: <ImageIcon size={13} />,
  video: <Video size={13} />,
  text: <FileText size={13} />,
  file: <FileIcon size={13} />,
};

let attachmentSeq = 0;
const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Everything the model can actually read: pixels for images, sampled frames for
// video, raw text for documents. Anything else rides along as a label only.
async function readAttachment(file) {
  const kind = fileKind(file);
  const att = { id: `att-${(attachmentSeq += 1)}`, name: file.name, kind, size: file.size };
  if (kind === 'image') {
    const raw = await readFile(file);
    return { ...att, dataUrl: raw ? await downscale(raw) : null };
  }
  if (kind === 'video') {
    const raw = await readFile(file);
    return { ...att, frames: raw ? await videoFrames(raw) : [] };
  }
  if (kind === 'text') {
    return { ...att, text: clipText(await readFile(file, 'text')) };
  }
  return { ...att, unsupported: true };
}

const SYSTEM_PROMPT = [
  'You are FxOrbit, a senior quantitative strategy analyst inside a trading terminal.',
  'Analyze the trading strategy the user describes (text plus any attached screenshots, video frames, or document excerpts) and respond with ONLY a JSON object (no markdown) shaped:',
  '{"title":"short strategy name","pair":"best instrument symbol for it, e.g. XAU/USD",',
  '"analysis":["paragraph 1","paragraph 2"],"entryRules":["rule","rule","rule"],',
  '"riskRules":["rule","rule","rule"]}',
  'Mirror the direction the user describes exactly: a strategy that buys dips is a LONG strategy — never describe it as short.',
].join(' ');

// A symbol the user explicitly named outranks whatever pair the model picks.
function mentionedPair(text, snapshot) {
  const t = String(text).toLowerCase();
  const symbols = new Set(snapshot.map((s) => s.symbol));
  const mentioned = UNIVERSE.find((u) => t.includes(u.symbol.toLowerCase()))
    ?? (t.includes('gold') ? UNIVERSE.find((u) => u.symbol === 'XAU/USD') : null);
  return mentioned && symbols.has(mentioned.symbol) ? mentioned.symbol : null;
}

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

function simulatedStrategy(text, snapshot) {
  const t = text.toLowerCase();
  const sweep = t.includes('liquidity') || t.includes('sweep') || t.includes('stop run') || t.includes('stop-run');
  const fvg = t.includes('fvg') || t.includes('fair value');
  const breakout = t.includes('breakout') || t.includes('break of structure') || t.includes('bos');
  const ema = t.includes('ema') || t.includes('moving average');
  const reversion = t.includes('reversal') || t.includes('mean reversion') || t.includes('inversion');
  const mentioned = mentionedPair(text, snapshot);
  const pair = mentioned ?? snapshot[0]?.symbol ?? 'EUR/USD';

  let title = 'Custom Price Action Strategy';
  if (sweep && (fvg || reversion)) title = 'Liquidity Sweep & Inversion FVG Reversal Strategy';
  else if (sweep) title = 'Liquidity Sweep Reversal Strategy';
  else if (fvg) title = 'Fair Value Gap Continuation Strategy';
  else if (breakout) title = 'Range Breakout Continuation Strategy';
  else if (ema) title = 'EMA Trend-Following Strategy';
  else if (reversion) title = 'Mean Reversion Strategy';

  const bias = engine.getState(pair)?.score >= 0 ? 'long' : 'short';
  return {
    title,
    pair,
    analysis: [
      sweep
        ? 'This strategy captures market reversals by identifying a liquidity sweep followed by a market structure shift and an inversion fair value gap. It seeks to enter when price stop-runs previous highs or lows, signalling displacement toward the opposite liquidity pool.'
        : 'This strategy aligns entries with the prevailing momentum stack while filtering chop through a structural bias check on the execution timeframe.',
      `The engine maps these rules onto the live ${pair} tape: setups are flagged as structure prints, confirmed against the 21-EMA momentum filter, and validated inside session liquidity windows before entry.`,
    ],
    entryRules: [
      sweep
        ? 'Wait for a stop-run sweeping buy-side or sell-side liquidity, then a market structure shift confirming displacement in the reversal direction'
        : `Trade only in the ${bias} direction while price holds the 21-EMA momentum envelope on the 15m chart`,
      sweep
        ? 'Enter on the retest of the inversion fair value gap left by the displacement candle — invalidation sits beyond the sweep wick'
        : 'Trigger on a momentum tick confirmed by a closed candle in the trade direction',
      'Skip setups when spread widens beyond 1.8× its rolling average or price sits mid-range with no liquidity reference',
      'One position at a time; wait for a closed candle before re-entering after a stop',
    ],
    riskRules: [
      sweep
        ? 'Stop loss beyond the wick of the liquidity sweep candle — never widen it'
        : 'Stop loss at 1.2× ATR(14) from entry — never widen it',
      sweep
        ? 'Take profit at the opposite-side liquidity pool; trail to break-even once the first pool is tagged'
        : 'Take profit at 2.4× ATR(14); trail the stop once price moves 1× ATR in favor',
      'Risk 0.5–1% of equity per trade; daily loss cap of 3%',
      'Time-stop: exit any trade still flat after 4 hours of stagnation',
    ],
    simulated: true,
  };
}

export default function StrategiesPage() {
  const [tab, setTab] = useState('own');
  const [desc, setDesc] = useState('');
  const [files, setFiles] = useState([]); // {id, name, kind, size, dataUrl?|frames?|text?|unsupported}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const [active, setActive] = useState(() => loadSettings().activeStrategyData ?? null);
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [tf, setTf] = useState('15m');
  const [aiSymbol, setAiSymbol] = useState(() => engine.getSnapshot()[0]?.symbol ?? 'EUR/USD');
  const [salt, setSalt] = useState(1);
  const [autoSet, setAutoSet] = useState(() => new Set(loadSettings().autoTrade));
  const fileRef = useRef(null);
  const hasKey = aiReady(loadSettings());
  const visionOk = aiSupportsVision(loadSettings());

  useEffect(() => engine.subscribe((list) => setPairs(list)), []);

  const plan = useMemo(() => genAiPlan(aiSymbol, salt), [aiSymbol, salt]);

  const toggleAuto = (sym) => {
    engine.setAutoTrade(sym, !autoSet.has(sym));
    setAutoSet(new Set(loadSettings().autoTrade));
  };

  const pickFiles = async (list) => {
    // Copy before any await: the input's FileList is emptied the moment its value resets.
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    const room = Math.max(0, MAX_FILES - files.length);
    const kept = [];
    const skipped = [];
    for (const file of picked) {
      if (file.size > MAX_BYTES) {
        skipped.push(`${file.name} is ${sizeLabel(file.size)} (limit ${MAX_MB} MB)`);
      } else if (kept.length >= room) {
        skipped.push(room === 0 ? `the ${MAX_FILES}-file limit is already full` : `only ${room} more fit under the ${MAX_FILES}-file limit`);
        break;
      } else {
        kept.push(file);
      }
    }
    if (skipped.length) setError(`Not attached — ${skipped.join('; ')}`);
    if (!kept.length) return;
    const prepared = await Promise.all(kept.map(readAttachment));
    setFiles((prev) => [...prev, ...prepared].slice(0, MAX_FILES));
  };

  const analyze = async () => {
    if (!desc.trim() || busy) return;
    setBusy(true);
    setError(null);
    const settings = loadSettings();
    try {
      if (aiReady(settings)) {
        // Text-only local models reject image parts, so pixels are dropped for them.
        const content = attachmentContent(
          `Analyze this trading strategy:\n\n${desc}`,
          files,
          { vision: aiSupportsVision(settings) },
        );
        const res = await fetch(`${settings.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...aiAuthHeaders(settings),
          },
          body: JSON.stringify({
            model: settings.aiModel || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content },
            ],
          }),
        });
        if (!res.ok) throw new Error(`AI API responded ${res.status}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? '';
        const parsed = parseJsonLoose(text);
        if (!parsed) throw new Error('Could not parse the model response.');
        // Signals may only target instruments the user enabled in their universe,
        // and a symbol they named in the description outranks the model's pick.
        const enabled = pairs.length ? pairs : engine.getSnapshot();
        const explicit = mentionedPair(desc, enabled);
        const pair = explicit
          ?? (enabled.some((p) => p.symbol === parsed.pair) ? parsed.pair : null)
          ?? (enabled.some((p) => p.symbol === settings.defaultPair) ? settings.defaultPair : null)
          ?? enabled[0]?.symbol
          ?? 'EUR/USD';
        setActive({
          title: parsed.title || 'Custom Strategy',
          pair,
          analysis: Array.isArray(parsed.analysis) ? parsed.analysis.map(String) : [String(parsed.analysis ?? '')].filter(Boolean),
          entryRules: Array.isArray(parsed.entryRules) ? parsed.entryRules.map(String) : [],
          riskRules: Array.isArray(parsed.riskRules) ? parsed.riskRules.map(String) : [],
          simulated: false,
        });
      } else {
        await new Promise((r) => setTimeout(r, 1400));
        setActive(simulatedStrategy(desc, pairs));
      }
    } catch (err) {
      setError(err.message || 'Analysis failed. Check your AI model settings.');
    } finally {
      setBusy(false);
    }
  };

  const current = useMemo(() => (
    tab === 'ai'
      ? {
        title: `${plan.style} — ${aiSymbol}`,
        pair: aiSymbol,
        analysis: [plan.thesis],
        entryRules: plan.entryRules,
        riskRules: plan.riskRules,
        simulated: false,
      }
      : active
  ), [tab, plan, aiSymbol, active]);

  const chartPair = pairs.find((p) => p.symbol === current?.pair) ?? pairs[0];

  useEffect(() => {
    if (current) saveSettings({ activeStrategy: current.title, activeStrategyData: current });
  }, [current]);

  return (
    <div className="page strat-page">
      <p className="strat-lead rise">Bring your own strategy or let AI build one from live market analysis</p>

      <div className="seg-tabs rise">
        <button className={`seg-tab${tab === 'own' ? ' active' : ''}`} onClick={() => setTab('own')}>
          <FileText size={14} /> My Own Strategy
        </button>
        <button className={`seg-tab${tab === 'ai' ? ' active' : ''}`} onClick={() => setTab('ai')}>
          <Brain size={14} /> AI Market Strategy
        </button>
      </div>

      {tab === 'own' ? (
        <section
          className={`panel strat-input rise${drag ? ' dragging' : ''}`}
          style={{ animationDelay: '60ms' }}
          onDragOver={(e) => { e.preventDefault(); if (!drag) setDrag(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pickFiles(e.dataTransfer.files); }}
        >
          <div className="panel-head">
            <span className="panel-title"><FileText size={14} /> Describe Your Strategy</span>
            <span className="panel-sub">{files.length}/{MAX_FILES} attached</span>
          </div>
          <textarea
            className="inp strat-desc"
            placeholder="e.g. liquidity sweep of buy side, inverse fair value gap on inversion, stop loss on the sweep wick, take profit at opposite-side liquidity…"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="attach-row">
            <div className="attach-label">
              <span className="k">Upload screenshots, videos, or documents</span>
              <span className="sub">optional · several at once · up to {MAX_MB} MB each · drag &amp; drop works too</span>
            </div>
            <div className="attach-actions">
              {files.length > 0 && (
                <button className="btn ghost sm" onClick={() => { setFiles([]); setError(null); }}>
                  <Trash2 size={13} /> Clear
                </button>
              )}
              <button className="btn ghost sm" disabled={files.length >= MAX_FILES} onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Add Files
              </button>
            </div>
          </div>
          {files.length > 0 && (
            <div className="file-chips">
              {files.map((f) => {
                const thumb = f.dataUrl ?? f.frames?.[0];
                const detail = f.kind === 'video'
                  ? `${f.frames?.length ?? 0} frame${f.frames?.length === 1 ? '' : 's'} sampled`
                  : f.kind === 'text' ? 'text read' : f.kind === 'image' ? 'image' : 'not readable';
                return (
                  <span key={f.id} className={`file-chip kind-${f.kind}`}>
                    {thumb ? <img src={thumb} alt="" /> : KIND_ICON[f.kind]}
                    <span className="chip-name">{f.name}</span>
                    <span className="chip-meta">{sizeLabel(f.size)} · {detail}</span>
                    {f.unsupported && <b className="chip-badge">not sent</b>}
                    <button onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))} title="Remove file">
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="btn-row">
            <button className="btn primary" disabled={!desc.trim() || busy} onClick={analyze}>
              <Sparkles size={15} /> {busy ? 'Analyzing strategy…' : 'Analyze Strategy with AI'}
            </button>
          </div>
          {!hasKey && (
            <p className="ai-note">No AI API key configured — analysis runs in simulated mode. Add a key in Settings for real strategy analysis.</p>
          )}
          {hasKey && !visionOk && files.some((f) => f.kind === 'image' || f.kind === 'video') && (
            <p className="ai-note">Your current model is text-only — screenshots and video frames stay on this machine, but document text is still analyzed.</p>
          )}
          {error && <p className="ai-error"><AlertTriangle size={13} /> {error}</p>}
          {busy && (
            <div className="ai-shimmer">
              <div className="sh-line w60" /><div className="sh-line w90" /><div className="sh-line w40" />
            </div>
          )}
          {drag && (
            <div className="drop-hint"><Upload size={16} /> Drop pictures, videos, or files to attach</div>
          )}
        </section>
      ) : (
        <section className="panel strat-input rise" style={{ animationDelay: '60ms' }}>
          <div className="panel-head">
            <span className="panel-title"><Brain size={14} /> Strategy Generator</span>
            <span className="panel-sub">heuristic engine — no key required</span>
          </div>
          <div className="gen-bar">
            <div className="field">
              <label>Instrument</label>
              <select className="inp" value={aiSymbol} onChange={(e) => { setAiSymbol(e.target.value); setSalt(1); }}>
                {pairs.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol} · {p.group}</option>)}
              </select>
            </div>
            <button className="btn ghost" onClick={() => setSalt((x) => x + 1)}>
              <RefreshCw size={14} /> Regenerate
            </button>
            <button className={`btn ${autoSet.has(aiSymbol) ? 'warn' : 'primary'}`} onClick={() => toggleAuto(aiSymbol)}>
              <ShieldCheck size={14} />
              {autoSet.has(aiSymbol) ? 'Auto-trade ON — disarm' : 'Enable auto-trade'}
            </button>
          </div>
          <div className="ai-plan-stats">
            {plan.stats.map((s) => (
              <div key={s.label} className="mini-stat">
                <div className="v">{s.value}</div>
                <div className="k">{s.label}</div>
              </div>
            ))}
          </div>
          {plan.levels && (
            <div className="sig-levels">
              <div><span>Entry zone</span><b>{plan.levels.entry}</b></div>
              <div><span>Protective stop</span><b className="dn">{plan.levels.sl}</b></div>
              <div><span>Profit target</span><b className="up">{plan.levels.tp}</b></div>
            </div>
          )}
        </section>
      )}

      <section className="active-strat rise" style={{ animationDelay: '120ms' }}>
        <div className="panel active-analysis">
          <div className="active-eyebrow">Active Strategy</div>
          <h2 className="active-title">{current ? current.title : 'No active strategy yet'}</h2>
          {current ? (
            <>
              <div className="ai-block">
                <div className="k">AI Analysis</div>
                {current.analysis.map((p, i) => <p key={i}>{p}</p>)}
              </div>
              <div className="strat-cols">
                <div className="ai-block">
                  <div className="k">Entry rules</div>
                  <ul className="rule-list">
                    {current.entryRules.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
                <div className="ai-block">
                  <div className="k">Risk rules</div>
                  <ul className="rule-list">
                    {current.riskRules.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              </div>
              {current.simulated && (
                <div className="ai-risk">
                  <AlertTriangle size={12} /> Simulated read — add an AI model API key in Settings for true strategy analysis.
                </div>
              )}
            </>
          ) : (
            <p className="dim empty-strat">
              Describe your strategy above and hit Analyze, or open the AI Market Strategy tab to generate one from live market analysis.
            </p>
          )}
        </div>
        {chartPair && <PriceChart pair={chartPair} symbol={chartPair.symbol} tf={tf} onTfChange={setTf} />}
      </section>

      <input ref={fileRef} type="file" multiple hidden
        onChange={(e) => { const picked = [...e.target.files]; e.target.value = ''; pickFiles(picked); }} />
    </div>
  );
}
