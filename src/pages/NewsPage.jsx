import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, Image as ImageIcon, X, Sparkles, AlertTriangle, Newspaper, KeyRound,
  Trash2, RefreshCw, Eye, EyeOff, Check, Activity, ShieldAlert,
} from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { loadSettings, saveSettings } from '../data/settings';
import {
  NEWS_CATEGORIES, NEWS_PROVIDERS, analyzeItem, closeNewsTrade, fetchNewsFeed, itemInUniverse,
  itemTitle, newsTrades, placeNewsTrade, riskFlags, tradeLive, universeCurrencies,
} from '../data/newsEngine';
import { downscale, parseJsonLoose, aiReady, aiAuthHeaders, aiSupportsVision } from '../utils/ai';

const SCREENSHOT_PROMPT = [
  'You are FxOrbit, a macro news-desk analyst inside a trading terminal.',
  'Analyze the news screenshot (headline or article) and respond with ONLY a JSON object (no markdown) shaped:',
  '{"headline":"the key headline from the screenshot","impact":"high|medium|low","sentiment":"bullish|bearish|neutral",',
  '"confidence":0-100,"affected":["instruments or currencies this news touches"],',
  '"summary":"2-3 sentence read of the likely market impact","riskNote":"1 sentence risk warning"}',
].join(' ');

const IMPACTS = ['all', 'high', 'medium', 'low'];
const RECENT_WINDOW = 10 * 3600;
const clock = (t) => new Date(t * 1000).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});

function relTime(t, now) {
  const d = t - now;
  const a = Math.abs(d);
  if (a < 60) return 'just now';
  const mins = Math.floor(a / 60);
  const hrs = Math.floor(mins / 60);
  const span = hrs >= 24 ? `${Math.floor(hrs / 24)}d` : hrs >= 1 ? `${hrs}h` : `${mins}m`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

function simulatedSnapshotRead(snapshot) {
  const sorted = [...snapshot].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const leader = sorted[0];
  const bull = leader.changePct >= 0;
  const vol = Math.abs(leader.changePct);
  const up = snapshot.filter((s) => s.changePct > 0).length;
  return {
    headline: 'Simulated desk read — screenshot text requires an AI key',
    impact: vol > 0.35 ? 'high' : vol > 0.12 ? 'medium' : 'low',
    sentiment: bull ? 'bullish' : 'bearish',
    confidence: Math.min(90, Math.round(55 + vol * 80)),
    affected: sorted.slice(0, 3).map((s) => s.symbol),
    summary: `${leader.symbol} leads the session at ${leader.changePct >= 0 ? '+' : ''}${leader.changePct.toFixed(2)}%, breadth at ${up} of ${snapshot.length} instruments in the green. ` +
      `${bull ? 'Headlines with this tilt tend to fuel risk-on follow-through while dips stay shallow.' : 'Headlines with this tilt tend to weigh on risk assets as rallies get sold into.'}`,
    riskNote: 'Simulated impact read — add an AI model API key in Settings for real news screenshot analysis.',
    simulated: true,
  };
}

export default function NewsPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [keyDraft, setKeyDraft] = useState(() => loadSettings().newsApiKey);
  const [showKey, setShowKey] = useState(false);
  const [items, setItems] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [feedError, setFeedError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [scope, setScope] = useState('pairs');
  const [selectedId, setSelectedId] = useState(null);
  const [analyses, setAnalyses] = useState({});
  const [analyzing, setAnalyzing] = useState(null);
  const [placed, setPlaced] = useState({});
  const [, setTick] = useState(0);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [toast, setToast] = useState(null);

  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shotResult, setShotResult] = useState(null);
  const [shotError, setShotError] = useState(null);
  const fileRef = useRef(null);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  useEffect(() => {
    const unsub = engine.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, []);

  // Keeps the recent/upcoming split live as time passes.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    setLoading(true);
    setFeedError(null);
    try {
      const feed = await fetchNewsFeed();
      setItems(feed.items);
      setWarnings(feed.warnings);
      setFetchedAt(feed.fetchedAt);
      setAnalyses({});
      setSelectedId(null);
    } catch (err) {
      setItems([]);
      setFeedError(String(err?.message ?? err));
    } finally {
      setLoading(false);
    }
  };

  // The calendar source is keyless, so the desk fills itself on first visit.
  useEffect(() => {
    const id = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(id);
  }, []);

  const saveKey = () => {
    const token = keyDraft.trim();
    saveSettings({ newsApiKey: token });
    setSettings((s) => ({ ...s, newsApiKey: token }));
    notify(token ? 'News API key saved' : 'News API key cleared');
  };

  const setProvider = (newsProvider) => {
    saveSettings({ newsProvider });
    setSettings((s) => ({ ...s, newsProvider }));
    void refresh();
  };

  const setCategory = (newsCategory) => {
    saveSettings({ newsCategory });
    setSettings((s) => ({ ...s, newsCategory }));
  };

  const analyze = async (item) => {
    setSelectedId(item.id);
    if (analyses[item.id] || analyzing) return;
    setAnalyzing(item.id);
    setAnalyses((prev) => ({ ...prev, [item.id]: { loading: true } }));
    try {
      const result = await analyzeItem(item);
      setAnalyses((prev) => ({ ...prev, [item.id]: result }));
    } catch (err) {
      setAnalyses((prev) => ({ ...prev, [item.id]: { error: String(err?.message ?? err) } }));
    } finally {
      setAnalyzing(null);
    }
  };

  const place = (item) => {
    const a = analyses[item.id];
    if (!a?.trade || placed[item.id]) return;
    const t = placeNewsTrade(a.trade, item);
    if (!t) { notify('Instrument unavailable'); return; }
    setPlaced((p) => ({ ...p, [item.id]: t.id }));
    notify(`${t.side} ${t.symbol} opened — terminal is managing SL/TP`);
  };

  const pickFile = async (file) => {
    if (!file) return;
    const raw = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(file);
    });
    setImage({ name: file.name, dataUrl: await downscale(raw) });
    setShotResult(null);
    setShotError(null);
  };

  const analyzeShot = async () => {
    if (!image || busy) return;
    setBusy(true);
    setShotError(null);
    setShotResult(null);
    const s = loadSettings();
    try {
      if (aiReady(s) && aiSupportsVision(s)) {
        const res = await fetch(`${s.aiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...aiAuthHeaders(s) },
          body: JSON.stringify({
            model: s.aiModel || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              { role: 'system', content: SCREENSHOT_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analyze this news screenshot and assess its market impact.' },
                  { type: 'image_url', image_url: { url: image.dataUrl } },
                ],
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`AI API responded ${res.status}`);
        const data = await res.json();
        const parsed = parseJsonLoose(data.choices?.[0]?.message?.content ?? '');
        if (!parsed) throw new Error('Could not parse the model response.');
        setShotResult({ ...parsed, simulated: false });
      } else {
        await new Promise((r) => setTimeout(r, 1400));
        setShotResult(simulatedSnapshotRead(engine.getSnapshot()));
      }
    } catch (err) {
      setShotError(err.message || 'Analysis failed. Check your AI model settings.');
    } finally {
      setBusy(false);
    }
  };

  const ccys = useMemo(() => universeCurrencies(settings.pairs), [settings.pairs]);
  const pairsItems = useMemo(() => items.filter((i) => itemInUniverse(i, ccys)), [items, ccys]);
  const scoped = scope === 'pairs' ? pairsItems : items;

  const counts = useMemo(() => {
    const c = { all: scoped.length, high: 0, medium: 0, low: 0 };
    for (const i of scoped) {
      const k = i.impact ?? 'low';
      if (c[k] != null) c[k] += 1;
    }
    return c;
  }, [scoped]);

  const visible = useMemo(
    () => (filter === 'all' ? scoped : scoped.filter((i) => (i.impact ?? 'low') === filter)),
    [scoped, filter],
  );

  const groups = useMemo(() => {
    const recent = [];
    const upcoming = [];
    const earlier = [];
    for (const i of visible) {
      if (i.time > nowSec) upcoming.push(i);
      else if (i.time >= nowSec - RECENT_WINDOW) recent.push(i);
      else earlier.push(i);
    }
    recent.sort((a, b) => b.time - a.time);
    upcoming.sort((a, b) => a.time - b.time);
    earlier.sort((a, b) => b.time - a.time);
    return [
      { key: 'recent', label: 'Recent & current · last 10h', items: recent },
      { key: 'upcoming', label: 'Upcoming', items: upcoming },
      { key: 'earlier', label: 'Earlier', items: earlier },
    ].filter((g) => g.items.length > 0);
  }, [visible, nowSec]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedAnalysis = selectedId ? analyses[selectedId] : null;
  const book = newsTrades();
  const recentShown = groups.find((g) => g.key === 'recent')?.items.length ?? 0;
  const upcomingShown = groups.find((g) => g.key === 'upcoming')?.items.length ?? 0;

  return (
    <div className="page news-page">
      <p className="news-lead rise">
        Live economic news and headlines, tiered by impact and pushed through the AI desk for a tradeable read.
      </p>

      <section className="panel news-desk rise" style={{ animationDelay: '40ms' }}>
        <div className="nd-head">
          <span className="panel-title"><Newspaper size={14} /> News Desk · Calendar + Macro Headlines</span>
          <span className={`nd-state${scoped.length && !feedError ? ' ok' : ''}`}>
            <span className="nd-dot" />
            {loading ? 'Fetching…' : scoped.length ? `${scoped.length} items` : feedError ? 'Feed error' : 'Idle'}
          </span>
        </div>

        <div className="nd-key-row">
          <div className="nd-key">
            <label>Headline provider</label>
            <select className="inp" value={settings.newsProvider} onChange={(e) => setProvider(e.target.value)}>
              {NEWS_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="field-hint">{NEWS_PROVIDERS.find((p) => p.id === settings.newsProvider)?.hint}</span>
          </div>
          <div className="nd-key">
            <label>News API key</label>
            <div className="inp-wrap">
              <input
                className="inp"
                type={showKey ? 'text' : 'password'}
                placeholder="Paste your provider key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button className="inp-eye" type="button" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <div className="nd-key-actions">
              <button className="btn primary sm" onClick={saveKey}><KeyRound size={13} /> Save key</button>
              <button className="btn ghost sm" onClick={() => { setKeyDraft(''); saveSettings({ newsApiKey: '' }); setSettings((s) => ({ ...s, newsApiKey: '' })); }}>
                <Trash2 size={13} /> Clear
              </button>
            </div>
          </div>
          {settings.newsProvider === 'finnhub' && (
            <div className="nd-key nd-key-sm">
              <label>Category</label>
              <select className="inp" value={settings.newsCategory} onChange={(e) => setCategory(e.target.value)}>
                {NEWS_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="nd-controls">
          <div className="seg-tabs nd-seg">
            <button className={`seg-tab${scope === 'pairs' ? ' active' : ''}`} onClick={() => setScope('pairs')}>
              My pairs<b>{pairsItems.length}</b>
            </button>
            <button className={`seg-tab${scope === 'all' ? ' active' : ''}`} onClick={() => setScope('all')}>
              All markets<b>{items.length}</b>
            </button>
          </div>
          <div className="seg-tabs nd-seg">
            {IMPACTS.map((k) => (
              <button key={k} className={`seg-tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>
                {k === 'all' ? 'All' : `${k[0].toUpperCase()}${k.slice(1)}`}
                <b>{counts[k] ?? 0}</b>
              </button>
            ))}
          </div>
          <button className="btn ghost sm" disabled={loading} onClick={refresh}>
            <RefreshCw size={13} className={loading ? 'spin' : undefined} /> Refresh desk
          </button>
          {fetchedAt && <span className="nd-fetched">fetched {clock(fetchedAt)} UTC</span>}
          {scope === 'pairs' && (
            <span className="nd-fetched">
              scoped to {settings.pairs.length} enabled pairs · edit universe in Settings
            </span>
          )}
        </div>

        {warnings.length > 0 && (
          <p className="nd-warn">{warnings.join(' · ')}</p>
        )}
        {feedError && <p className="ai-error"><AlertTriangle size={13} /> {feedError}</p>}
        {items.length > 0 && scoped.length === 0 && (
          <p className="ai-note">
            No feed items touch your {settings.pairs.length} enabled pairs right now.{' '}
            <button className="btn ghost sm" onClick={() => setScope('all')}>Show all markets</button>
          </p>
        )}
        {!feedError && settings.newsProvider === 'rss' && (
          <p className="ai-note">
            Headlines stream from keyless RSS desks — FXStreet, ForexLive, Investing.com and CNBC — so the
            desk stays current with no API key. Analysis runs on the desk heuristic until an AI model key
            is set in Settings.
          </p>
        )}
        {settings.newsProvider !== 'rss' && !settings.newsApiKey && !feedError && (
          <p className="ai-note">
            The economic calendar is live without a key. Add a headline provider key above to also pull macro
            news with sentiment scores — or switch the provider to RSS for keyless headlines. Analysis runs on
            the desk heuristic until an AI model key is set in Settings.
          </p>
        )}
      </section>

      {scoped.length > 0 && (
        <div className="news-desk-grid">
          <section className="panel rise" style={{ animationDelay: '80ms' }}>
            <div className="panel-head">
              <span className="panel-title">News feed</span>
              <span className="panel-sub">
                {visible.length} shown · {recentShown} recent · {upcomingShown} upcoming · click to analyze
              </span>
            </div>
            <div className="news-scroll">
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <div className={`news-group ${g.key}`}>
                    <span>{g.label}</span>
                    <b>{g.items.length}</b>
                  </div>
                  {g.items.map((item) => {
                    const a = analyses[item.id];
                    const rated = item.impact ?? a?.impact ?? null;
                    return (
                      <button
                        key={item.id}
                        className={`news-row${selectedId === item.id ? ' on' : ''}`}
                        onClick={() => analyze(item)}
                      >
                        <span className="nr-flags">
                          {rated
                            ? <span className={`impact-chip ${rated}`}>{rated.slice(0, 3).toUpperCase()}</span>
                            : <span className="chip nr-kind">NEW</span>}
                          <span className="chip nr-kind">{item.feed === 'calendar' ? 'CAL' : 'NEWS'}</span>
                        </span>
                        <span className="nr-body">
                          <b>{itemTitle(item)}</b>
                          <span className="nr-meta">
                            {clock(item.time)} · {relTime(item.time, nowSec)}
                            {item.currency ? ` · ${item.currency}` : item.source ? ` · ${item.source}` : ''}
                            {item.actual != null ? ` · act ${item.actual}` : ''}
                            {item.estimate != null ? ` · fcst ${item.estimate}` : ''}
                            {item.previous != null ? ` · prev ${item.previous}` : ''}
                          </span>
                        </span>
                        <span className="nr-tail">
                          {a?.loading ? <Activity size={13} className="spin" />
                            : a && !a.error ? <span className={`trend-chip ${a.sentiment}`}>{a.sentiment.slice(0, 3).toUpperCase()}</span>
                            : item.sentiment && item.sentiment !== 'neutral'
                              ? <span className="trend-chip prov">{item.sentiment.slice(0, 3).toUpperCase()}</span>
                              : null}
                        </span>
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </section>

          <section className="panel rise" style={{ animationDelay: '120ms' }}>
            <div className="panel-head">
              <span className="panel-title"><Sparkles size={14} /> AI desk read</span>
              {selectedAnalysis && !selectedAnalysis.error && (
                <span className="panel-sub">{selectedAnalysis.simulated ? 'desk heuristic' : 'model analysed'}</span>
              )}
            </div>

            {!selected && <p className="ai-note">Pick a news item to analyze its impact and generate a trade plan.</p>}
            {selectedAnalysis?.error && <p className="ai-error"><AlertTriangle size={13} /> {selectedAnalysis.error}</p>}
            {selectedAnalysis?.loading && (
              <div className="ai-shimmer"><div className="sh-line w60" /><div className="sh-line w90" /><div className="sh-line w40" /></div>
            )}

            {selected && selectedAnalysis && !selectedAnalysis.loading && !selectedAnalysis.error && (() => {
              const a = selectedAnalysis;
              const plan = a.trade;
              return (
                <div className="ai-result">
                  <div className="ai-result-head">
                    <span className={`impact-chip ${a.impact}`}>{a.impact.toUpperCase()} IMPACT</span>
                    <span className={`trend-chip ${a.sentiment}`}>{a.sentiment.toUpperCase()}</span>
                    {a.simulated && <span className="chip">simulated</span>}
                    {a.aiError && <span className="chip warn">AI fallback</span>}
                  </div>
                  <div className="conf-row">
                    <span>Confidence</span>
                    <div className="conf-bar"><i style={{ width: `${a.confidence}%` }} /></div>
                    <b>{Math.round(a.confidence)}%</b>
                  </div>
                  <div className="ai-block">
                    <div className="k">Item</div>
                    <p>{itemTitle(selected)}</p>
                  </div>
                  <div className="ai-block">
                    <div className="k">Pair read</div>
                    <p className="pair-read">
                      <b data-dir={a.read?.direction ?? a.sentiment}>{(a.read?.direction ?? a.sentiment).toUpperCase()}</b>
                      {a.read?.symbol ? ` for ${a.read.symbol}` : ''}
                      {(a.read?.direction ?? a.sentiment) === 'neutral'
                        ? ' — no directional edge for this instrument on this item.'
                        : ` — the desk expects ${a.read.symbol} to move ${a.read.direction === 'bullish' ? 'higher' : 'lower'} on this item.`}
                    </p>
                  </div>
                  <div className="ai-block">
                    <div className="k">Market impact</div>
                    <p>{a.summary}</p>
                  </div>
                  {a.currencies?.length > 0 && (
                    <div className="ai-block">
                      <div className="k">Currencies in focus</div>
                      <div className="level-chips">{a.currencies.map((c) => <span key={c} className="level-chip plain">{c}</span>)}</div>
                    </div>
                  )}

                  {plan ? (
                    <div className="news-plan">
                      <div className="np-head">
                        <span className="np-side" data-side={plan.side}>{plan.side}</span>
                        <b>{plan.symbol}</b>
                        <span className="np-horizon">{plan.horizon} · R:R {plan.rr}</span>
                      </div>
                      <div className="np-grid">
                        <div><span className="k">Entry</span><b className="num">{fmt(plan.entry, plan.decimals)}</b></div>
                        <div><span className="k">Stop loss</span><b className="num down">{fmt(plan.sl, plan.decimals)}</b></div>
                        <div><span className="k">Take profit</span><b className="num up">{fmt(plan.tp, plan.decimals)}</b></div>
                        <div><span className="k">Risk / Reward</span><b>{plan.slPips}p / {plan.tpPips}p</b></div>
                      </div>
                      {plan.reasoning && <p className="np-reason">{plan.reasoning}</p>}
                      <div className="ai-risk"><AlertTriangle size={12} /> {plan.riskNote}</div>
                      <button className="btn primary" disabled={!!placed[selected.id]} onClick={() => place(selected)}>
                        <Check size={14} /> {placed[selected.id] ? `Placed as ${placed[selected.id]}` : 'Place trade'}
                      </button>
                      <span className="field-hint">The terminal manages stop, target and time-stop from here; watch it in the desk book below.</span>
                    </div>
                  ) : (
                    <div className="news-plan wait">
                      <b>No trade — desk says WAIT</b>
                      <span className="field-hint">The desk stays flat on low-impact items and reads with no clear directional edge — a plan needs a tradable tier and a decisive tone.</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </section>
        </div>
      )}

      {book.open.length + book.closed.length > 0 && (
        <section className="panel rise" style={{ animationDelay: '160ms' }}>
          <div className="panel-head">
            <span className="panel-title"><ShieldAlert size={14} /> Desk trade book</span>
            <span className="panel-sub">{book.open.length} open · {book.closed.length} closed</span>
          </div>
          <table className="watch">
            <thead>
              <tr><th>ID</th><th>News item</th><th>Pair</th><th>Side</th><th>Entry</th><th>SL / TP</th><th>Pips</th><th>P&amp;L</th><th></th></tr>
            </thead>
            <tbody>
              {[...book.open, ...book.closed.slice(0, 5)].map((t) => {
                const live = tradeLive(t);
                const s = engine.getState(t.symbol);
                const dec = s?.decimals ?? 5;
                const flags = t.status === 'open' ? riskFlags(t, items, analyses) : [];
                const gain = t.status === 'open' ? live.pips : t.pips;
                const money = t.status === 'open' ? live.pnl : t.pnl;
                return (
                  <tr key={t.id}>
                    <td className="dim">{t.id}</td>
                    <td className="dt-note" title={t.note ?? ''}>{t.note ?? '—'}
                      {flags.length > 0 && <span className="dt-flag"> conflicting high-impact news</span>}
                    </td>
                    <td>{t.symbol}</td>
                    <td className={t.side === 'BUY' ? 'up' : 'dn'}>{t.side}</td>
                    <td className="num">{fmt(t.entry, dec)}</td>
                    <td className="num dim">{fmt(t.sl, dec)} / {fmt(t.tp, dec)}</td>
                    <td className={`num ${gain >= 0 ? 'up' : 'dn'}`}>{gain >= 0 ? '+' : ''}{gain}</td>
                    <td className={`num ${money >= 0 ? 'up' : 'dn'}`}>{money >= 0 ? '+' : ''}{money.toFixed(2)}</td>
                    <td>
                      {t.status === 'open'
                        ? <button className="btn ghost sm" onClick={() => { closeNewsTrade(t.id); notify(`${t.id} closed at market`); }}><X size={12} /> Close</button>
                        : <span className={`result-badge ${t.pnl > 0 ? 'win' : 'loss'}`}>{t.exitReason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel news-upload rise" style={{ animationDelay: '200ms' }}>
        <div className="upload-icon"><Newspaper size={24} /></div>
        <h2>Analyze a news screenshot</h2>
        <p className="upload-sub">No feed item matching what you are reading? Upload a headline screenshot and the desk will tier its impact the same way.</p>
        <button className="btn primary" onClick={() => fileRef.current?.click()}>
          <Upload size={15} /> Upload News Screenshot
        </button>
      </section>

      <section
        className="panel news-status rise"
        style={{ animationDelay: '240ms' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}
      >
        {!image ? (
          <div className="dropzone status-empty" onClick={() => fileRef.current?.click()}>
            <ImageIcon size={26} strokeWidth={1.5} />
            <b>No screenshot uploaded yet</b>
            <span>drop a PNG / JPG here or click to browse</span>
          </div>
        ) : (
          <div className="ai-preview">
            <img src={image.dataUrl} alt="news screenshot" />
            <div className="ai-preview-bar">
              <span className="dim">{image.name}</span>
              <div className="btn-row">
                <button className="btn ghost sm" onClick={() => { setImage(null); setShotResult(null); setShotError(null); }}>
                  <X size={13} /> Remove
                </button>
                <button className="btn primary sm" disabled={busy} onClick={analyzeShot}>
                  <Sparkles size={13} /> {busy ? 'Analyzing…' : aiReady(settings) && aiSupportsVision(settings) ? 'Analyze with AI' : 'Analyze (simulated)'}
                </button>
              </div>
            </div>
          </div>
        )}

        {busy && (
          <div className="ai-shimmer"><div className="sh-line w60" /><div className="sh-line w90" /><div className="sh-line w40" /></div>
        )}
        {shotError && <p className="ai-error"><AlertTriangle size={13} /> {shotError}</p>}

        {shotResult && (
          <div className="ai-result">
            <div className="ai-result-head">
              <span className={`impact-chip ${shotResult.impact || 'medium'}`}>{(shotResult.impact || 'medium').toUpperCase()} IMPACT</span>
              <span className={`trend-chip ${shotResult.sentiment || 'neutral'}`}>{(shotResult.sentiment || 'neutral').toUpperCase()}</span>
              {shotResult.simulated && <span className="chip">simulated</span>}
            </div>
            <div className="conf-row">
              <span>Model confidence</span>
              <div className="conf-bar"><i style={{ width: `${shotResult.confidence}%` }} /></div>
              <b>{shotResult.confidence}%</b>
            </div>
            {shotResult.headline && (
              <div className="ai-block"><div className="k">Headline</div><p>{shotResult.headline}</p></div>
            )}
            {shotResult.affected?.length > 0 && (
              <div className="ai-block">
                <div className="k">Instruments in focus</div>
                <div className="level-chips">{shotResult.affected.slice(0, 8).map((x) => <span key={x} className="level-chip plain">{x}</span>)}</div>
              </div>
            )}
            <div className="ai-block"><div className="k">Market impact</div><p>{shotResult.summary}</p></div>
            <div className="ai-risk"><AlertTriangle size={12} /> {shotResult.riskNote}</div>
          </div>
        )}

        {aiReady(settings) && !aiSupportsVision(settings) && !shotResult && !busy && (
          <p className="ai-note">Your local model is text-only — screenshot analysis runs a simulated read. Point the provider at a vision model or an OpenAI-compatible key for real image analysis.</p>
        )}
        {!aiReady(settings) && !shotResult && !busy && (
          <p className="ai-note">No AI backend configured — screenshot analysis runs in simulated mode. Connect a model in Settings for real analysis.</p>
        )}
      </section>

      <input ref={fileRef} type="file" accept="image/*" hidden
        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
