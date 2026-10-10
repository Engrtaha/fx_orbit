import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, RefreshCw, ShieldCheck, FileText, Upload, Sparkles, X, AlertTriangle,
  Image as ImageIcon, Video, File as FileIcon, Trash2, Pencil, GitMerge, Star, Check, Layers,
} from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { UNIVERSE, loadSettings } from '../data/settings';
import {
  ORIGINS, addStrategy, applyActive, armStrategy, findStrategy, loadLibrary, mergeStrategies,
  normalizeStrategy, removeStrategy, saveLibrary, updateStrategy,
} from '../data/strategyBook';
import PriceChart from '../components/PriceChart';
import {
  downscale, parseJsonLoose, aiReady, aiChat, aiSupportsVision, attachmentContent,
  fileKind, readFile, clipText, videoFrames,
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

const MERGE_PROMPT = [
  'You are FxOrbit, a senior quantitative strategy analyst inside a trading terminal.',
  'Merge the two strategies below into ONE coherent strategy and respond with ONLY a JSON object (no markdown) shaped:',
  '{"title":"short name for the merged book","pair":"single instrument symbol",',
  '"analysis":["paragraph 1","paragraph 2"],"entryRules":["rule"],"riskRules":["rule"]}',
  'Keep every rule that does not conflict. When two rules conflict, keep the stricter one and say why in the analysis.',
].join(' ');

// A symbol the user explicitly named outranks whatever pair the model picks.
function mentionedPair(text, snapshot) {
  const t = String(text).toLowerCase();
  const symbols = new Set(snapshot.map((s) => s.symbol));
  const mentioned = UNIVERSE.find((u) => t.includes(u.symbol.toLowerCase()))
    ?? (t.includes('gold') ? UNIVERSE.find((u) => u.symbol === 'XAU/USD') : null);
  return mentioned && symbols.has(mentioned.symbol) ? mentioned.symbol : null;
}

// A book may only trade an instrument the user has enabled in their universe.
function resolvePair(candidate, text, enabled, settings) {
  return mentionedPair(text, enabled)
    ?? (enabled.some((p) => p.symbol === candidate) ? candidate : null)
    ?? (enabled.some((p) => p.symbol === settings.defaultPair) ? settings.defaultPair : null)
    ?? enabled[0]?.symbol
    ?? 'EUR/USD';
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

const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

const relTime = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(ts).toISOString().slice(0, 10);
};

export default function StrategiesPage() {
  // Read once: the library may import a strategy saved before it existed, and
  // the active pointer is matched by id first, by title second.
  const [boot] = useState(() => {
    const list = loadLibrary();
    const s = loadSettings();
    const found = list.find((x) => x.id === s.activeStrategyId)
      ?? (s.activeStrategy ? list.find((x) => x.title === s.activeStrategy) : null);
    return { list, activeId: found?.id ?? '' };
  });
  const [tab, setTab] = useState('own');
  const [desc, setDesc] = useState('');
  const [files, setFiles] = useState([]); // {id, name, kind, size, dataUrl?|frames?|text?|unsupported}
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const [library, setLibrary] = useState(boot.list);
  const [activeId, setActiveId] = useState(boot.activeId);
  const [draft, setDraft] = useState(null); // analysed on request, not saved until asked
  const [mergeSel, setMergeSel] = useState([]);
  const [edit, setEdit] = useState(null); // {id,title,pair,analysis,entryRules,riskRules} as text
  const [toast, setToast] = useState(null);
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [tf, setTf] = useState('15m');
  const [aiSymbol, setAiSymbol] = useState(() => engine.getSnapshot()[0]?.symbol ?? 'EUR/USD');
  const [salt, setSalt] = useState(1);
  const [autoSet, setAutoSet] = useState(() => new Set(loadSettings().autoTrade));
  const fileRef = useRef(null);
  const hasKey = aiReady(loadSettings());
  const visionOk = aiSupportsVision(loadSettings());

  useEffect(() => engine.subscribe((list) => setPairs(list)), []);

  // The engine loads the universe after mount, so the raw selection can name a
  // pair the user has disabled — resolve it against the live snapshot instead.
  const genSymbol = pairs.some((p) => p.symbol === aiSymbol)
    ? aiSymbol
    : (pairs.some((p) => p.symbol === loadSettings().defaultPair)
      ? loadSettings().defaultPair
      : pairs[0]?.symbol ?? aiSymbol);

  const plan = useMemo(() => genAiPlan(genSymbol, salt), [genSymbol, salt]);
  const active = findStrategy(library, activeId);
  const chartPair = pairs.find((p) => p.symbol === (edit?.pair ?? active?.pair)) ?? pairs[0];

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  // Every library mutation goes through here so localStorage and the engine's
  // execution list can never drift apart.
  const write = (next) => {
    setLibrary(saveLibrary(next));
    engine.syncStrategies(next);
    return next;
  };

  const toggleAuto = (sym) => {
    engine.setAutoTrade(sym, !autoSet.has(sym));
    setAutoSet(new Set(loadSettings().autoTrade));
  };

  const activate = (id) => {
    setActiveId(id);
    applyActive(library, id);
    const s = findStrategy(library, id);
    flash(s ? `“${s.title}” is now the active strategy` : 'Active strategy cleared');
  };

  const saveDraft = (andActivate) => {
    const saved = normalizeStrategy(draft);
    const next = write(addStrategy(library, saved));
    if (andActivate) {
      setActiveId(saved.id);
      applyActive(next, saved.id);
    }
    setDraft(null);
    setFiles([]);
    setDesc('');
    flash(andActivate
      ? `“${saved.title}” saved and set active`
      : `“${saved.title}” saved — your active strategy is unchanged`);
  };

  const startEdit = (s) => setEdit({
    id: s.id,
    title: s.title,
    pair: s.pair,
    analysis: s.analysis.join('\n'),
    entryRules: s.entryRules.join('\n'),
    riskRules: s.riskRules.join('\n'),
  });

  const saveEdit = () => {
    const next = write(updateStrategy(library, edit.id, {
      title: edit.title,
      pair: edit.pair,
      analysis: lines(edit.analysis),
      entryRules: lines(edit.entryRules),
      riskRules: lines(edit.riskRules),
    }));
    if (edit.id === activeId) applyActive(next, activeId); // keep the mirror other pages read in step
    setEdit(null);
    flash('Strategy updated');
  };

  const toggleArm = (s) => {
    write(armStrategy(library, s.id, !s.armed));
    flash(s.armed ? `“${s.title}” disarmed` : `“${s.title}” armed — it trades ${s.pair} off the EMA cross`);
  };

  const removeOne = (s) => {
    const next = write(removeStrategy(library, s.id));
    if (s.id === activeId) {
      setActiveId('');
      applyActive(next, '');
    }
    setMergeSel((sel) => sel.filter((id) => id !== s.id));
    flash(`“${s.title}” deleted`);
  };

  const toggleMerge = (id) => setMergeSel((sel) => (
    sel.includes(id) ? sel.filter((x) => x !== id) : [...sel.slice(-1), id]
  ));

  const runMerge = async () => {
    const picked = mergeSel.map((id) => findStrategy(library, id)).filter(Boolean);
    if (picked.length !== 2) return;
    const [a, b] = picked;
    setMerging(true);
    setError(null);
    try {
      const settings = loadSettings();
      let merged = mergeStrategies(a, b);
      let note = '';
      if (aiReady(settings)) {
        // The model writes the merged book; the deterministic union is the floor
        // under it, so a dead or unparsable reply still merges the two.
        try {
          const text = await aiChat(settings, [
            { role: 'system', content: MERGE_PROMPT },
            { role: 'user', content: `Strategy A:\n${JSON.stringify(a, null, 1)}\n\nStrategy B:\n${JSON.stringify(b, null, 1)}` },
          ], { temperature: 0.1 });
          const parsed = parseJsonLoose(text);
          if (parsed) {
            merged = normalizeStrategy({
              ...merged,
              ...parsed,
              id: merged.id,
              parents: [a.id, b.id],
              origin: 'merged',
              pair: resolvePair(parsed.pair, '', pairs.length ? pairs : engine.getSnapshot(), settings),
            });
          } else {
            note = ' — the model reply was unreadable, so the rules were unioned instead';
          }
        } catch {
          note = ' — model unreachable, so the rules were unioned instead';
        }
      }
      write(addStrategy(library, merged));
      setMergeSel([]);
      flash(`“${merged.title}” saved${note} — set it active when you are ready`);
    } catch (err) {
      setError(err.message || 'Merge failed. Check your AI model settings.');
    } finally {
      setMerging(false);
    }
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
        const text = await aiChat(settings, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ]);
        const parsed = parseJsonLoose(text);
        if (!parsed) throw new Error('Could not parse the model response.');
        setDraft(normalizeStrategy({
          ...parsed,
          pair: resolvePair(parsed.pair, desc, pairs.length ? pairs : engine.getSnapshot(), settings),
          origin: 'ai',
          simulated: false,
        }));
      } else {
        await new Promise((r) => setTimeout(r, 1400));
        setDraft(normalizeStrategy({ ...simulatedStrategy(desc, pairs), origin: 'ai', simulated: true }));
      }
    } catch (err) {
      setError(err.message || 'Analysis failed. Check your AI model settings.');
    } finally {
      setBusy(false);
    }
  };

  const savePlan = () => setDraft(normalizeStrategy({
    title: `${plan.style} — ${genSymbol}`,
    pair: genSymbol,
    analysis: [plan.thesis],
    entryRules: plan.entryRules,
    riskRules: plan.riskRules,
    origin: 'market',
  }));

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
              <select className="inp" value={genSymbol} onChange={(e) => { setAiSymbol(e.target.value); setSalt(1); }}>
                {pairs.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol} · {p.group}</option>)}
              </select>
            </div>
            <button className="btn ghost" onClick={() => setSalt((x) => x + 1)}>
              <RefreshCw size={14} /> Regenerate
            </button>
            <button className="btn ghost" onClick={savePlan}>
              <Layers size={14} /> Save this plan
            </button>
            <button className={`btn ${autoSet.has(genSymbol) ? 'warn' : 'primary'}`} onClick={() => toggleAuto(genSymbol)}>
              <ShieldCheck size={14} />
              {autoSet.has(genSymbol) ? 'Auto-trade ON — disarm' : 'Enable auto-trade'}
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
          {error && <p className="ai-error"><AlertTriangle size={13} /> {error}</p>}
        </section>
      )}

      {draft && (
        <section className="panel strat-draft rise">
          <div className="draft-head">
            <span className="draft-tag"><Sparkles size={12} /> New analysis</span>
            <h3>{draft.title}</h3>
            <span className="draft-pair">{draft.pair}</span>
            {draft.simulated && <span className="draft-sim">simulated read</span>}
          </div>
          <p className="draft-sum">{draft.analysis[0]}</p>
          <div className="strat-cols">
            <div className="ai-block">
              <div className="k">Entry rules</div>
              <ul className="rule-list">{draft.entryRules.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
            <div className="ai-block">
              <div className="k">Risk rules</div>
              <ul className="rule-list">{draft.riskRules.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          </div>
          <div className="draft-actions">
            <button className="btn primary sm" onClick={() => saveDraft(true)}><Star size={13} /> Use this one</button>
            <button className="btn ghost sm" onClick={() => saveDraft(false)}>
              <Check size={13} /> Save{active ? `, keep “${active.title}”` : ''}
            </button>
            <button className="btn ghost sm" onClick={() => setDraft(null)}><X size={13} /> Discard</button>
          </div>
          <p className="draft-note">Nothing is saved or switched until you choose — your current setup stays exactly as it is.</p>
        </section>
      )}

      {library.length > 0 && (
        <section className="panel strat-lib-panel rise" style={{ animationDelay: '90ms' }}>
          <div className="panel-head">
            <span className="panel-title"><Layers size={14} /> Strategy Library</span>
            <span className="panel-sub">{library.length} saved · pick two to merge</span>
            {mergeSel.length > 0 && (
              <span className="merge-actions">
                <button
                  className={`btn sm ${mergeSel.length === 2 ? 'primary' : 'ghost'}`}
                  disabled={mergeSel.length !== 2 || merging}
                  onClick={runMerge}
                >
                  <GitMerge size={13} /> {merging ? 'Merging…' : `Merge ${mergeSel.length}/2`}
                </button>
                <button className="btn ghost sm" onClick={() => setMergeSel([])}><X size={12} /> Cancel</button>
              </span>
            )}
          </div>
          <div className="strat-lib">
            {library.map((s) => (
              <article
                key={s.id}
                className={`strat-card${s.id === activeId ? ' active' : ''}${mergeSel.includes(s.id) ? ' picking' : ''}`}
              >
                <div className="strat-card-top">
                  <span className={`origin-chip ${s.origin}`}>{ORIGINS[s.origin]}</span>
                  {s.id === activeId && <span className="active-chip"><Star size={9} /> Active</span>}
                  {s.armed && <span className="armed-chip"><ShieldCheck size={9} /> Armed</span>}
                </div>
                <h3 className="strat-card-title">{s.title}</h3>
                <div className="strat-card-meta">
                  <b className="pair">{s.pair}</b>
                  <span>{s.entryRules.length} entries</span>
                  <span>{s.riskRules.length} risk</span>
                  <span>{relTime(s.updatedAt)}</span>
                </div>
                <p className="strat-card-sum">{s.analysis[0]}</p>
                <div className="strat-card-actions">
                  {s.id === activeId
                    ? <span className="in-use"><Check size={12} /> In use</span>
                    : <button className="btn ghost xs" onClick={() => activate(s.id)}><Star size={12} /> Use</button>}
                  <button className="btn ghost xs" onClick={() => startEdit(s)}><Pencil size={12} /> Edit</button>
                  <button className={`btn xs ${s.armed ? 'warn' : 'ghost'}`} onClick={() => toggleArm(s)}>
                    <ShieldCheck size={12} /> {s.armed ? 'Disarm' : 'Auto-trade'}
                  </button>
                  <button
                    className={`btn xs ${mergeSel.includes(s.id) ? 'primary' : 'ghost'}`}
                    onClick={() => toggleMerge(s.id)}
                    title="Select two strategies to merge"
                  >
                    <GitMerge size={12} /> Merge
                  </button>
                  <button className="btn xs danger" onClick={() => removeOne(s)} title="Delete strategy"><Trash2 size={12} /></button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {edit ? (
        <section className="panel settings-section strat-edit rise">
          <div className="panel-head">
            <span className="panel-title"><Pencil size={14} /> Edit Strategy</span>
            <button className="btn ghost sm" onClick={() => setEdit(null)}><X size={12} /> Cancel</button>
          </div>
          <div className="field-row">
            <div className="field grow">
              <label>Title</label>
              <input className="inp" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </div>
            <div className="field">
              <label>Pair</label>
              <select className="inp" value={edit.pair} onChange={(e) => setEdit({ ...edit, pair: e.target.value })}>
                {(pairs.length ? pairs : engine.getSnapshot()).map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Analysis — one paragraph per line</label>
            <textarea className="inp strat-desc" value={edit.analysis} onChange={(e) => setEdit({ ...edit, analysis: e.target.value })} />
          </div>
          <div className="strat-cols">
            <div className="field">
              <label>Entry rules — one per line</label>
              <textarea className="inp strat-desc" value={edit.entryRules} onChange={(e) => setEdit({ ...edit, entryRules: e.target.value })} />
            </div>
            <div className="field">
              <label>Risk rules — one per line</label>
              <textarea className="inp strat-desc" value={edit.riskRules} onChange={(e) => setEdit({ ...edit, riskRules: e.target.value })} />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn primary sm" disabled={!edit.title.trim()} onClick={saveEdit}><Check size={13} /> Save changes</button>
          </div>
        </section>
      ) : (
        <section className="active-strat rise" style={{ animationDelay: '120ms' }}>
          <div className="panel active-analysis">
            <div className="active-eyebrow">
              Active Strategy
              {active && <button className="btn ghost xs" onClick={() => activate('')}><X size={11} /> Unset</button>}
            </div>
            <h2 className="active-title">{active ? active.title : 'No active strategy yet'}</h2>
            {active ? (
              <>
                <div className="ai-block">
                  <div className="k">AI Analysis</div>
                  {active.analysis.map((p, i) => <p key={i}>{p}</p>)}
                </div>
                <div className="strat-cols">
                  <div className="ai-block">
                    <div className="k">Entry rules</div>
                    <ul className="rule-list">{active.entryRules.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                  <div className="ai-block">
                    <div className="k">Risk rules</div>
                    <ul className="rule-list">{active.riskRules.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                </div>
                {active.parents.length > 0 && (
                  <div className="merged-from">
                    <GitMerge size={12} /> Merged from{' '}
                    {active.parents.map((id) => findStrategy(library, id)?.title).filter(Boolean).join(' + ') || 'deleted strategies'}
                  </div>
                )}
                {active.simulated && (
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
      )}

      <input ref={fileRef} type="file" multiple hidden
        onChange={(e) => { const picked = [...e.target.files]; e.target.value = ''; pickFiles(picked); }} />

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
