import { useEffect, useState } from 'react';
import { Pencil, Save, X, Check } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { loadSettings, saveSettings, subscribeSettings } from '../data/settings';

const money = (v) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v) => `${v >= 0 ? '+' : '-'}${money(v)}`;

function computeStats() {
  const trades = engine.getTrades();
  const closed = trades.filter((t) => t.status === 'closed');
  const open = trades.filter((t) => t.status === 'open');
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const netPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.pnl, 0);

  let unrealized = 0;
  for (const t of open) {
    const s = engine.getState(t.symbol);
    if (!s) continue;
    const dir = t.side === 'BUY' ? 1 : -1;
    unrealized += (((s.mid - t.entry) * dir) / s.pip) * (t.lots / 0.1);
  }

  const weekStart = new Date();
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const weekAgo = weekStart.getTime();

  const best = closed.reduce((a, t) => (!a || t.pnl > a.pnl ? t : a), null);
  const worst = closed.reduce((a, t) => (!a || t.pnl < a.pnl ? t : a), null);

  return {
    winCount: wins.length,
    lossCount: losses.length,
    closedCount: closed.length,
    openCount: open.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    netPnl: +netPnl.toFixed(2),
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    unrealized: +unrealized.toFixed(2),
    avgWin: wins.length ? +(grossProfit / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
    weekPnl: +closed.filter((t) => (t.closedAt ?? 0) >= weekAgo).reduce((a, t) => a + t.pnl, 0).toFixed(2),
    thisWeek: trades.filter((t) => (t.openedAt ?? 0) >= weekAgo).length,
    recentClosed: closed.slice(0, 6),
    best,
    worst,
  };
}

function Donut({ wins, losses, winRate }) {
  const total = wins + losses;
  const frac = total ? wins / total : 0.5;
  const R = 70;
  const C = 2 * Math.PI * R;
  return (
    <svg viewBox="0 0 200 200" className="donut" role="img" aria-label={`Win ${wins} / Loss ${losses}`}>
      <g transform="rotate(-90 100 100)">
        <circle cx="100" cy="100" r={R} fill="none" stroke="#2dd4a7" strokeWidth="26"
          strokeDasharray={`${frac * C} ${C}`} />
        <circle cx="100" cy="100" r={R} fill="none" stroke="#fb4b6a" strokeWidth="26"
          strokeDasharray={`${(1 - frac) * C} ${C}`} strokeDashoffset={-frac * C} />
      </g>
      <text x="100" y="96" textAnchor="middle" className="donut-pct">{Math.round(winRate * 100)}%</text>
      <text x="100" y="118" textAnchor="middle" className="donut-cap">win rate</text>
    </svg>
  );
}

export default function PortfolioPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [stats, setStats] = useState(computeStats);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ balance: 0, initialBalance: 100, riskPerTrade: 2, defaultPair: 'XAU/USD' });
  const [toast, setToast] = useState(null);

  useEffect(() => engine.subscribe(() => setStats(computeStats())), []);
  useEffect(() => subscribeSettings(setSettings), []);

  const baseInitial = +settings.initialBalance;
  const liveBalance = baseInitial + stats.netPnl + (+settings.balanceAdjust || 0);
  const previewInitial = editing ? Math.max(0, +draft.initialBalance || 0) : baseInitial;
  const balance = editing ? Math.max(0, +draft.balance || 0) : liveBalance;
  const totalPnl = balance - previewInitial;
  const enabled = engine.getSnapshot();

  const startEdit = () => {
    setDraft({
      balance: liveBalance.toFixed(2),
      initialBalance: settings.initialBalance,
      riskPerTrade: settings.riskPerTrade,
      defaultPair: settings.defaultPair,
    });
    setEditing(true);
  };

  const saveAccount = () => {
    const initial = Math.max(0, +draft.initialBalance || 0);
    const risk = Math.min(100, Math.max(0.1, +draft.riskPerTrade || 1));
    const target = Math.max(0, +draft.balance || 0);
    saveSettings({
      initialBalance: initial,
      riskPerTrade: risk,
      defaultPair: draft.defaultPair,
      balanceAdjust: +(target - initial - stats.netPnl).toFixed(2),
    });
    setEditing(false);
    setToast('Portfolio updated');
    setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className="page portfolio-page">
      <div className="pf-head">
        <button className="btn ghost sm" onClick={editing ? () => setEditing(false) : startEdit}>
          {editing ? <><X size={13} /> Cancel</> : <><Pencil size={13} /> Edit</>}
        </button>
      </div>

      <section className="panel portfolio-summary rise">
        <div className="pf-stat">
          <div className="k">Balance</div>
          <div className="v">{money(balance)}</div>
          <div className={`d ${stats.unrealized >= 0 ? 'up' : 'dn'}`}>{signed(stats.unrealized)} floating</div>
        </div>
        <div className="pf-stat">
          <div className="k">Total P&amp;L</div>
          <div className={`v ${totalPnl >= 0 ? 'up' : 'dn'}`}>{signed(totalPnl)}</div>
          <div className="d">{signed(stats.weekPnl)} this week · initial {money(previewInitial)}</div>
        </div>
        <div className="pf-stat">
          <div className="k">Win Rate</div>
          <div className="v">{Math.round(stats.winRate * 100)}%</div>
          <div className="d">{stats.winCount}W / {stats.lossCount}L of {stats.closedCount} closed</div>
        </div>
        <div className="pf-stat">
          <div className="k">Open Trades</div>
          <div className="v">{stats.openCount}</div>
          <div className="d">{stats.thisWeek} opened this week</div>
        </div>
      </section>

      {editing && (
        <section className="panel settings-section pf-edit rise">
          <div className="field-row">
            <div className="field">
              <label>Balance ($)</label>
              <input className="inp" type="number" min="0" step="0.01"
                value={draft.balance}
                onChange={(e) => setDraft({ ...draft, balance: e.target.value })} />
            </div>
            <div className="field">
              <label>Initial Balance ($)</label>
              <input className="inp" type="number" min="0" step="1"
                value={draft.initialBalance}
                onChange={(e) => setDraft({ ...draft, initialBalance: e.target.value })} />
            </div>
            <div className="field">
              <label>Risk Per Trade (%)</label>
              <input className="inp" type="number" min="0.1" max="100" step="0.1"
                value={draft.riskPerTrade}
                onChange={(e) => setDraft({ ...draft, riskPerTrade: e.target.value })} />
            </div>
            <div className="field">
              <label>Active Pair</label>
              <select className="inp" value={draft.defaultPair}
                onChange={(e) => setDraft({ ...draft, defaultPair: e.target.value })}>
                {enabled.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol}</option>)}
              </select>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={saveAccount}><Save size={14} /> Save Changes</button>
          </div>
        </section>
      )}

      <div className="portfolio-grid">
        <section className="panel settings-section rise" style={{ animationDelay: '60ms' }}>
          <div className="panel-head">
            <span className="panel-title">Win / Loss Breakdown</span>
            <span className="panel-sub">all closed trades</span>
          </div>
          <div className="donut-wrap">
            <Donut wins={stats.winCount} losses={stats.lossCount} winRate={stats.winRate} />
            <div className="donut-legend">
              <span className="legend-item win"><i /> Wins ({stats.winCount})</span>
              <span className="legend-item loss"><i /> Losses ({stats.lossCount})</span>
            </div>
          </div>
          <div className="account-rows pf-breakdown">
            <div className="account-row">
              <span className="k">Gross profit</span>
              <b className="v up">{signed(stats.grossProfit)}</b>
            </div>
            <div className="account-row">
              <span className="k">Gross loss</span>
              <b className="v dn">{signed(stats.grossLoss)}</b>
            </div>
            <div className="account-row">
              <span className="k">Avg winning trade</span>
              <b className="v up">{signed(stats.avgWin)}</b>
            </div>
            <div className="account-row">
              <span className="k">Avg losing trade</span>
              <b className="v dn">{signed(stats.avgLoss)}</b>
            </div>
            <div className="account-row">
              <span className="k">Net P&amp;L</span>
              <b className={`v ${stats.netPnl >= 0 ? 'up' : 'dn'}`}>{signed(stats.netPnl)}</b>
            </div>
          </div>
        </section>

        <section className="panel settings-section rise" style={{ animationDelay: '120ms' }}>
          <div className="panel-head">
            <span className="panel-title">Account Info</span>
          </div>
          <div className="account-rows">
            <div className="account-row">
              <span className="k">Active Pair</span>
              <b className="v">{settings.defaultPair}</b>
            </div>
            <div className="account-row">
              <span className="k">Strategy</span>
              <b className="v">{settings.activeStrategy || 'None — analyze one on the Strategies page'}</b>
            </div>
            <div className="account-row">
              <span className="k">Risk per Trade</span>
              <b className="v">{settings.riskPerTrade}%</b>
            </div>
            <div className="account-row">
              <span className="k">Best Trade</span>
              <b className="v up">{stats.best ? `${stats.best.symbol} · ${signed(stats.best.pnl)}` : '—'}</b>
            </div>
            <div className="account-row">
              <span className="k">Worst Trade</span>
              <b className="v dn">{stats.worst ? `${stats.worst.symbol} · ${signed(stats.worst.pnl)}` : '—'}</b>
            </div>
            <div className="account-row">
              <span className="k">Trades This Week</span>
              <b className="v">{stats.thisWeek}</b>
            </div>
            <div className="account-row">
              <span className="k">Open Trades</span>
              <b className="v">{stats.openCount}</b>
            </div>
          </div>
        </section>
      </div>

      <section className="panel settings-section pf-recent rise" style={{ animationDelay: '180ms' }}>
        <div className="panel-head">
          <div className="head-col">
            <span className="panel-title">Recent Closed Trades</span>
            <span className="panel-sub">latest outcomes driving these numbers</span>
          </div>
        </div>
        {stats.recentClosed.length === 0 ? (
          <p className="dim empty">No closed trades yet.</p>
        ) : (
          <table className="watch">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Pips</th>
                <th>P&amp;L</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentClosed.map((t) => {
                const dec = engine.getState(t.symbol)?.decimals ?? 5;
                return (
                  <tr key={t.id}>
                    <td className="pair-cell"><b>{t.symbol}</b></td>
                    <td className={t.side === 'BUY' ? 'up' : 'dn'}>{t.side}</td>
                    <td className="num">{fmt(t.entry, dec)}</td>
                    <td className="num">{fmt(t.exit, dec)}</td>
                    <td className={`num ${t.pips >= 0 ? 'up' : 'dn'}`}>{t.pips > 0 ? '+' : ''}{t.pips}</td>
                    <td className={`num ${t.pnl >= 0 ? 'up' : 'dn'}`}>{signed(t.pnl)}</td>
                    <td><span className={`result-badge ${t.pnl > 0 ? 'win' : 'loss'}`}>{t.pnl > 0 ? 'WIN' : 'LOSS'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}
    </div>
  );
}
