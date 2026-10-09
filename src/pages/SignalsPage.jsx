import { useEffect, useMemo, useState } from 'react';
import { Zap, ChevronDown, ArrowDownRight, ArrowUpRight, Loader2, Minus } from 'lucide-react';
import { engine, fmt, TIMEFRAMES } from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import { generateAiSignal } from '../data/signalEngine';

export default function SignalsPage() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [settings] = useState(() => loadSettings());
  const [pairSel, setPair] = useState(() => {
    const snap = engine.getSnapshot();
    return snap.some((s) => s.symbol === settings.defaultPair) ? settings.defaultPair : snap[0]?.symbol ?? 'EUR/USD';
  });
  const [tf, setTf] = useState('15m');
  const [mode, setMode] = useState('my');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => engine.subscribe(setPairs), []);

  const strategyName = settings.activeStrategy || 'AI Best';
  const subtitleStrategy = mode === 'my' ? strategyName : 'AI Best Strategy';

  // The engine loads the universe asynchronously — until it arrives the raw
  // selection can point outside the snapshot, so resolve it against live pairs.
  const pair = pairs.some((p) => p.symbol === pairSel)
    ? pairSel
    : (pairs.some((p) => p.symbol === settings.defaultPair) ? settings.defaultPair : pairs[0]?.symbol ?? pairSel);

  const state = useMemo(() => pairs.find((p) => p.symbol === pair), [pairs, pair]);

  const strategyRules = () => {
    const d = settings.activeStrategyData;
    if (!d || mode !== 'my') return null;
    return {
      name: strategyName,
      rules: [d.analysis, d.entryRules, d.riskRules]
        .flat()
        .filter(Boolean)
        .join(' ')
        .slice(0, 500),
    };
  };

  const generate = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const r = await generateAiSignal(pair, tf, strategyRules());
      if (r) setResult({ ...r, mode });
    } finally {
      setBusy(false);
    }
  };

  const WaitIcon = result?.side === 'LONG' ? ArrowUpRight : result?.side === 'SHORT' ? ArrowDownRight : Minus;

  return (
    <div className="page signals-page">
      <p className="strat-lead">AI-powered analysis using {strategyName} strategy</p>

      <section className="panel sig-gen rise">
        <div className="sig-gen-icon"><Zap size={28} strokeWidth={1.8} /></div>
        <h2>Generate Trading Signal</h2>
        <p className="sig-gen-sub">
          Select a pair and the AI will analyze it using the {subtitleStrategy} strategy.
        </p>

        <div className="sig-select-wrap">
          <select className="sig-select" value={pair} onChange={(e) => { setPair(e.target.value); setResult(null); }}>
            {pairs.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol}</option>)}
          </select>
          <ChevronDown size={16} className="sig-caret" />
        </div>

        <div className="sig-select-wrap">
          <select className="sig-select" value={tf} onChange={(e) => setTf(e.target.value)}>
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t} timeframe</option>)}
          </select>
          <ChevronDown size={16} className="sig-caret" />
        </div>

        <div className="sig-mode">
          <button className={`mode-btn${mode === 'my' ? ' on' : ''}`} onClick={() => setMode('my')}>My Strategy</button>
          <button className={`mode-btn${mode === 'ai' ? ' on' : ''}`} onClick={() => setMode('ai')}>AI Best Strategy</button>
        </div>

        <button className="sig-generate" onClick={generate} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
          {busy ? 'Analyzing market…' : `Generate Signal for ${pair}`}
        </button>
      </section>

      {result && (
        <section className="panel open-trade rise">
          <div className="panel-head">
            <span className="panel-title">Open Trade — {result.symbol}</span>
            <span className="panel-sub">
              {result.tf} · {result.mode === 'my' ? strategyName : 'AI Best Strategy'}
              {result.simulated ? ' · engine fallback' : ` · ${settings.aiModel || 'AI model'}`}
            </span>
          </div>
          <div className="ot-body">
            <div className={`ot-side ${result.side === 'LONG' ? 'up' : result.side === 'SHORT' ? 'dn' : 'wait'}`}>
              <WaitIcon size={22} />
              <b>{result.side}</b>
            </div>
            <div className="ot-levels">
              <div className="ot-box">
                <span>Entry</span>
                <b>{fmt(result.entry, result.decimals)}</b>
              </div>
              <div className="ot-box">
                <span>Stop Loss</span>
                <b className="dn">{result.sl == null ? '—' : fmt(result.sl, result.decimals)}</b>
              </div>
              <div className="ot-box">
                <span>Take Profit</span>
                <b className="up">{result.tp == null ? '—' : fmt(result.tp, result.decimals)}</b>
              </div>
            </div>
          </div>
          <div className="ot-foot">
            <div className="conf-row">
              <span>Confidence</span>
              <div className="conf-bar"><i style={{ width: `${result.confidence}%` }} /></div>
              <b>{result.confidence}%</b>
            </div>
            {result.rr != null && <div className="ot-rr">R : R <b>{result.rr.toFixed(2)}</b></div>}
            <div className="reason-chips">
              {result.reasons.slice(0, 3).map((r) => <span key={r} className="chip">{r}</span>)}
            </div>
          </div>
          {result.side === 'WAIT' && (
            <p className="sig-note">No trade — the model sees no clean setup right now. Regenerate later or pick another pair.</p>
          )}
          {result.summary && <p className="sig-note">{result.summary}</p>}
          {result.aiError && <p className="sig-note warn">AI model error — showing engine fallback. {result.aiError}</p>}
        </section>
      )}
    </div>
  );
}
