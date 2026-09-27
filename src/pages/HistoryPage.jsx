import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, Percent, Layers, Activity, Sigma } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { Badges } from '../components/shared';

const FILTERS = ['All', 'Open', 'Wins', 'Losses'];
const SOURCES = ['All Sources', 'Manual', 'AI Signal', 'Strategy'];

function timeAgo(ts) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function EquityCurve({ trades }) {
  const pts = useMemo(() => {
    const closed = trades
      .filter((t) => t.status === 'closed')
      .slice()
      .sort((a, b) => a.closedAt - b.closedAt);
    if (closed.length < 2) return null;
    let cum = 0;
    const data = closed.map((t) => ({ t: t.closedAt, v: (cum += t.pnl) }));
    const min = Math.min(0, ...data.map((d) => d.v));
    const max = Math.max(1, ...data.map((d) => d.v));
    const W = 600, H = 130, P = 8;
    const path = data.map((d, i) => {
      const x = P + (i / (data.length - 1)) * (W - 2 * P);
      const y = H - P - ((d.v - min) / (max - min)) * (H - 2 * P);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return { path, end: data[data.length - 1].v, W, H, zero: H - P - ((0 - min) / (max - min)) * (H - 2 * P) };
  }, [trades]);

  if (!pts) return <div className="eq-empty">Close more trades to draw the equity curve.</div>;
  return (
    <svg viewBox={`0 0 ${pts.W} ${pts.H}`} className="eq-chart" preserveAspectRatio="none">
      <line x1="0" y1={pts.zero} x2={pts.W} y2={pts.zero} stroke="rgba(148,163,184,0.2)" strokeDasharray="3 4" />
      <path d={`${pts.path} L${pts.W - 8},${pts.H} L8,${pts.H} Z`} fill="url(#eqfill)" opacity="0.5" />
      <path d={pts.path} fill="none" stroke={pts.end >= 0 ? '#2dd4a7' : '#fb4b6a'} strokeWidth="2" strokeLinejoin="round" />
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={pts.end >= 0 ? '#2dd4a7' : '#fb4b6a'} stopOpacity="0.35" />
          <stop offset="100%" stopColor={pts.end >= 0 ? '#2dd4a7' : '#fb4b6a'} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function HistoryPage() {
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState('All');
  const [source, setSource] = useState('All Sources');

  useEffect(() => engine.subscribe((_, tick) => setTick(tick)), []);

  const trades = engine.getTrades();
  const stats = engine.tradeStats();

  const filtered = useMemo(() => trades.filter((t) => {
    if (filter === 'Open' && t.status !== 'open') return false;
    if (filter === 'Wins' && !(t.status === 'closed' && t.pnl > 0)) return false;
    if (filter === 'Losses' && !(t.status === 'closed' && t.pnl <= 0)) return false;
    if (source !== 'All Sources' && t.source !== source) return false;
    return true;
  }), [trades, filter, source]);

  return (
    <div className="page">
      <div className="stat-row">
        <div className="stat-card rise">
          <div className={`stat-ic ${stats.netPnl >= 0 ? 'green' : 'rose'}`}><Sigma size={17} /></div>
          <div>
            <div className={`v ${stats.netPnl >= 0 ? 'up' : 'down'}`}>
              {stats.netPnl >= 0 ? '+' : ''}{fmt(stats.netPnl, 2)} USD
            </div>
            <div className="k">Net P&amp;L</div>
          </div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '40ms' }}>
          <div className="stat-ic cyan"><Percent size={17} /></div>
          <div><div className="v">{stats.winRate}%</div><div className="k">Win Rate</div></div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '80ms' }}>
          <div className="stat-ic violet"><Layers size={17} /></div>
          <div><div className="v">{stats.closedCount}<span className="dim"> / {stats.openCount} open</span></div><div className="k">Closed Trades</div></div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '120ms' }}>
          <div className="stat-ic amber"><Activity size={17} /></div>
          <div><div className="v">{fmt(stats.profitFactor, 2)}</div><div className="k">Profit Factor</div></div>
        </div>
      </div>

      <section className="panel eq-panel rise">
        <div className="panel-head">
          <span className="panel-title"><TrendingUp size={14} /> Equity Curve</span>
          <span className="panel-sub">cumulative P&amp;L across closed trades</span>
        </div>
        <EquityCurve trades={trades} />
      </section>

      <div className="hist-controls">
        <div className="pills">
          {FILTERS.map((f) => (
            <button key={f} className={`pill${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <select className="inp sm" value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      <section className="panel watch rise">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Instrument</th><th>Side</th><th>Entry</th><th>Exit</th>
              <th>SL / TP</th><th>Pips</th><th>P&amp;L</th><th>Source</th><th>Status</th><th>Closed</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const s = engine.getState(t.symbol);
              const dec = s ? s.decimals : 5;
              return (
                <tr key={t.id}>
                  <td className="dim">{t.id}</td>
                  <td>
                    <span className="wl-pair">
                      {s && <Badges base={s.base} quote={s.quote} size={22} />}
                      <b>{t.symbol}</b>
                    </span>
                  </td>
                  <td><span className={`side-badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                  <td className="num">{fmt(t.entry, dec)}</td>
                  <td className="num">{t.status === 'open' ? <span className="pulse-dot" /> : fmt(t.exit, dec)}</td>
                  <td className="num dim">{fmt(t.sl, dec)} / {fmt(t.tp, dec)}</td>
                  <td className={`num ${t.status === 'open' ? '' : t.pips >= 0 ? 'up' : 'down'}`}>
                    {t.status === 'open' ? '—' : `${t.pips >= 0 ? '+' : ''}${t.pips}`}
                  </td>
                  <td className={`num ${t.status === 'open' ? '' : t.pnl >= 0 ? 'up' : 'down'}`}>
                    {t.status === 'open' ? '—' : `${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl, 2)}`}
                  </td>
                  <td className="dim">{t.source}</td>
                  <td>
                    <span className={`status-badge ${t.status === 'open' ? 'open' : t.pnl > 0 ? 'win' : 'loss'}`}>
                      {t.status === 'open' ? 'OPEN' : t.exitReason.toUpperCase()}
                    </span>
                  </td>
                  <td className="dim">{t.status === 'open' ? timeAgo(t.openedAt) : timeAgo(t.closedAt)}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={11} className="dim" style={{ textAlign: 'center', padding: 26 }}>No trades match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
