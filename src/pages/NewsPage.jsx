import { useMemo, useRef, useState } from 'react';
import {
  Newspaper, Upload, Image as ImageIcon, X, Sparkles, Camera, AlertTriangle, CheckCircle2, MinusCircle,
} from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import { chartCapture } from '../data/chartCapture';
import { Badges, signalClass } from '../components/shared';

const NEWS = [
  { title: 'Fed officials signal patience on rate path ahead of PCE data', source: 'MarketWatch', mins: 12, impact: 'high', tags: ['USD', 'Rates'] },
  { title: 'ECB minutes: further easing debated as eurozone growth stalls', source: 'Reuters', mins: 26, impact: 'high', tags: ['EUR'] },
  { title: 'Gold holds near record highs as real yields drift lower', source: 'Bloomberg', mins: 41, impact: 'med', tags: ['XAU', 'Metals'] },
  { title: 'US100 futures climb as megacap earnings momentum builds', source: 'CNBC', mins: 55, impact: 'med', tags: ['US100', 'Equities'] },
  { title: 'BoJ intervention chatter lifts yen from multi-week lows', source: 'FT', mins: 74, impact: 'high', tags: ['JPY'] },
  { title: 'UK CPI cools more than expected, sterling slips', source: 'Reuters', mins: 96, impact: 'med', tags: ['GBP'] },
  { title: 'Oil rally stalls; CAD traders eye upcoming BOC remarks', source: 'FX Street', mins: 128, impact: 'low', tags: ['CAD', 'Oil'] },
  { title: 'NVDA extends lead as AI capex cycle shows no slowdown', source: 'Barron\'s', mins: 151, impact: 'low', tags: ['NVDA', 'Equities'] },
  { title: 'RBA minutes: board balanced on inflation persistence', source: 'AFR', mins: 187, impact: 'low', tags: ['AUD'] },
  { title: 'Turkey central bank holds; lira volatility compresses', source: 'Reuters', mins: 220, impact: 'low', tags: ['TRY', 'EM'] },
  { title: 'US30 rebalances lift industrials; breadth improves', source: 'WSJ', mins: 263, impact: 'low', tags: ['US30'] },
  { title: 'Silver demand outlook brightens on solar buildout', source: 'Kitco', mins: 305, impact: 'med', tags: ['XAG', 'Metals'] },
];

const SYSTEM_PROMPT = [
  'You are FxOrbit, an elite technical-analysis engine inside a trading terminal.',
  'Analyze the chart screenshot and respond with ONLY a JSON object (no markdown) shaped:',
  '{"trend":"bullish|bearish|ranging","confidence":0-100,"pattern":"string",',
  '"keyLevels":[{"price":number,"kind":"support|resistance"}],"signal":"STRONG BUY|BUY|NEUTRAL|SELL|STRONG SELL",',
  '"summary":"2-3 sentence read of the chart","riskNote":"1 sentence risk warning"}',
].join(' ');

function impactDot(impact) {
  return impact === 'high' ? 'hi' : impact === 'med' ? 'md' : 'lo';
}

function impactLabel(impact) {
  return impact === 'high' ? 'HIGH IMPACT' : impact === 'med' ? 'MEDIUM' : 'LOW';
}

function downscale(dataUrl, max = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function simulatedAnalysis(snapshot) {
  const bullish = snapshot.filter((s) => s.score > 0).length;
  const bearish = snapshot.filter((s) => s.score < 0).length;
  const leader = [...snapshot].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
  const d = leader ? engine.getDetail(leader) : null;
  const bull = (leader?.score ?? 0) >= 0;
  return {
    trend: bull ? 'bullish' : 'bearish',
    confidence: Math.min(92, 58 + Math.abs(leader?.score ?? 0) * 8),
    pattern: leader && Math.abs(leader.score) >= 3
      ? 'Momentum continuation with trend-following confirmation'
      : 'Consolidation structure with building directional pressure',
    keyLevels: d && leader ? [
      { price: +d.sl.toFixed(leader.decimals), kind: 'support' },
      { price: +d.tp.toFixed(leader.decimals), kind: 'resistance' },
    ] : [],
    signal: leader ? leader.signal : 'NEUTRAL',
    summary: leader
      ? `${leader.symbol} leads the board with ${bullish} instruments bullish versus ${bearish} bearish. ` +
        `Momentum on ${leader.symbol} reads ${leader.momentum >= 0 ? 'positive' : 'negative'} at ` +
        `${leader.momentum.toFixed(3)}% with RSI ${leader.rsi.toFixed(0)}, suggesting ` +
        `${bull ? 'buyers retain control while pullbacks stay shallow' : 'sellers dominate and rallies are being sold'}.`
      : 'Market breadth is balanced with no clear directional leader.',
    riskNote: 'Simulated read — connect an AI model API key in Settings for true vision analysis of your screenshot.',
    simulated: true,
  };
}

function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export default function NewsPage() {
  const [image, setImage] = useState(null); // {name, dataUrl}
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const snapshot = useMemo(() => engine.getSnapshot(), []);

  const pickFile = async (file) => {
    if (!file) return;
    const raw = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(file);
    });
    setImage({ name: file.name, dataUrl: await downscale(raw) });
    setResult(null);
    setError(null);
  };

  const useLiveChart = () => {
    const dataUrl = chartCapture.fn ? chartCapture.fn() : chartCapture.last;
    if (!dataUrl) return;
    setImage({ name: 'FxOrbit live chart capture', dataUrl });
    setResult(null);
    setError(null);
  };

  const hasCapture = !!(chartCapture.fn || chartCapture.last);

  const analyze = async () => {
    if (!image || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const settings = loadSettings();
    try {
      if (settings.aiApiKey) {
        const res = await fetch(`${settings.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.aiApiKey}`,
          },
          body: JSON.stringify({
            model: settings.aiModel || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analyze this chart screenshot.' },
                  { type: 'image_url', image_url: { url: image.dataUrl } },
                ],
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`AI API responded ${res.status}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? '';
        const parsed = parseJsonLoose(text);
        if (!parsed) throw new Error('Could not parse the model response.');
        setResult({ ...parsed, simulated: false });
      } else {
        await new Promise((r) => setTimeout(r, 1400));
        setResult(simulatedAnalysis(snapshot));
      }
    } catch (err) {
      setError(err.message || 'Analysis failed. Check your AI API key in Settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page news-layout">
      <div className="news-feed">
        <div className="sec-title"><Newspaper size={14} /> Market Headlines</div>
        <div className="news-list">
          {NEWS.map((n, i) => (
            <article key={n.title} className="panel news-item rise" style={{ animationDelay: `${i * 35}ms` }}>
              <div className={`impact ${impactDot(n.impact)}`} />
              <div className="news-body">
                <div className="news-meta">
                  <span className={`impact-tag ${impactDot(n.impact)}`}>{impactLabel(n.impact)}</span>
                  <span>{n.source}</span>
                  <span>·</span>
                  <span>{n.mins}m ago</span>
                </div>
                <h3>{n.title}</h3>
                <div className="news-tags">
                  {n.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="ai-panel-wrap">
        <div className="sec-title"><Sparkles size={14} /> AI Chart Analysis</div>
        <section className="panel ai-panel rise">
          <div className="panel-head">
            <span className="panel-title"><ImageIcon size={14} /> Upload a screenshot</span>
            <span className="panel-sub">chart capture → AI vision read</span>
          </div>

          {!image ? (
            <div className="dropzone" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}>
              <Upload size={26} strokeWidth={1.5} />
              <b>Drop a chart screenshot here</b>
              <span>or click to browse — PNG / JPG</span>
              {hasCapture && (
                <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); useLiveChart(); }}>
                  <Camera size={13} /> Use live chart capture
                </button>
              )}
            </div>
          ) : (
            <div className="ai-preview">
              <img src={image.dataUrl} alt="chart upload" />
              <div className="ai-preview-bar">
                <span className="dim">{image.name}</span>
                <button className="btn ghost sm" onClick={() => setImage(null)}><X size={13} /> Remove</button>
              </div>
            </div>
          )}

          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />

          <button className="btn primary analyze-btn" disabled={!image || busy} onClick={analyze}>
            <Sparkles size={15} />
            {busy ? 'Analyzing chart…' : loadSettings().aiApiKey ? 'Analyze with AI model' : 'Analyze (simulated mode)'}
          </button>
          {!loadSettings().aiApiKey && (
            <p className="ai-note">No AI API key configured — running the built-in simulated engine. Add a key in Settings for real vision analysis.</p>
          )}
          {error && <p className="ai-error"><AlertTriangle size={13} /> {error}</p>}

          {busy && (
            <div className="ai-shimmer">
              <div className="sh-line w60" /><div className="sh-line w90" /><div className="sh-line w40" />
            </div>
          )}

          {result && (
            <div className="ai-result">
              <div className="ai-result-head">
                <span className={`sig ${signalClass(result.signal)}`}>{result.signal}</span>
                <span className={`trend-chip ${result.trend}`}>{result.trend.toUpperCase()}</span>
                {result.simulated && <span className="chip">simulated</span>}
              </div>
              <div className="conf-row">
                <span>Model confidence</span>
                <div className="conf-bar"><i style={{ width: `${result.confidence}%` }} /></div>
                <b>{result.confidence}%</b>
              </div>
              <div className="ai-block">
                <div className="k">Pattern</div>
                <p>{result.pattern}</p>
              </div>
              {result.keyLevels?.length > 0 && (
                <div className="ai-block">
                  <div className="k">Key levels</div>
                  <div className="level-chips">
                    {result.keyLevels.slice(0, 6).map((l, i) => (
                      <span key={i} className={`level-chip ${l.kind}`}>
                        {l.kind === 'support' ? <CheckCircle2 size={11} /> : <MinusCircle size={11} />}
                        {fmt(l.price, l.price > 500 ? 1 : l.price > 10 ? 2 : 4)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="ai-block">
                <div className="k">Summary</div>
                <p>{result.summary}</p>
              </div>
              <div className="ai-risk"><AlertTriangle size={12} /> {result.riskNote}</div>
            </div>
          )}
        </section>

        <section className="panel movers rise" style={{ animationDelay: '80ms' }}>
          <div className="panel-head">
            <span className="panel-title">Session Movers</span>
          </div>
          <div className="movers-list">
            {[...snapshot]
              .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
              .slice(0, 6)
              .map((s) => (
                <div key={s.symbol} className="mover-row">
                  <Badges base={s.base} quote={s.quote} size={20} />
                  <b>{s.symbol}</b>
                  <span className={`num ${s.changePct >= 0 ? 'up' : 'down'}`} style={{ marginLeft: 'auto' }}>
                    {s.changePct >= 0 ? '+' : ''}{s.changePct.toFixed(2)}%
                  </span>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}
