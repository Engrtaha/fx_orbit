import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, TrendingUp, Percent, Target } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { loadSettings, subscribeSettings } from '../data/settings';

const money = (v) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v) => `${v >= 0 ? '+' : '-'}${money(v)}`;

const SESSION_BARS = [
  { name: 'Asia', utc: [0, 9], color: '#8b5cf6' },
  { name: 'London', utc: [8, 17], color: '#2dd4a7' },
  { name: 'New York', utc: [13, 22], color: '#f59e0b' },
];

const KILL_ZONES = [
  { name: 'London Open Kill Zone', time: '07:00 – 09:00' },
  { name: 'NY AM Session', time: '09:30 – 12:00' },
  { name: 'NY PM Session / Silver Bullet', time: '14:00 – 15:00' },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const weekStart = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * 86400e3;
};

const greeting = (h) => (h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening');

function computeStats() {
  const trades = engine.getTrades();
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.pnl > 0).length;
  const netPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const ws = weekStart();
  const thisWeek = closed.filter((t) => t.closedAt >= ws);
  const daily = DAYS.map((_, i) =>
    thisWeek
      .filter((t) => Math.floor((t.closedAt - ws) / 86400e3) === i)
      .reduce((a, t) => a + t.pnl, 0)
  );
  return {
    wins,
    losses: closed.length - wins,
    open: trades.filter((t) => t.status === 'open').length,
    netPnl: +netPnl.toFixed(2),
    weekPnl: +thisWeek.reduce((a, t) => a + t.pnl, 0).toFixed(2),
    daily,
    recent: thisWeek.slice(0, 8),
  };
}

export default function DashboardPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [stats, setStats] = useState(computeStats);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const unsub = engine.subscribe(() => setStats(computeStats()));
    const unsubSettings = subscribeSettings(setSettings);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => { unsub(); unsubSettings(); clearInterval(t); };
  }, []);

  const balance = +settings.initialBalance + stats.netPnl + (+settings.balanceAdjust || 0);
  const total = stats.wins + stats.losses;
  const winRate = total ? Math.round((stats.wins / total) * 100) : 0;
  const maxDay = Math.max(...stats.daily.map(Math.abs), 1);
  const hourUtc = now.getUTCHours() + now.getUTCMinutes() / 60;
  const firstName = settings.profileName.split(' ')[0];

  return (
    <div className="page dash-page">
      <div className="dash-hero rise">
        <div>
          <h2 className="dash-hello">{greeting(now.getUTCHours())}, {firstName}!</h2>
          <p className="dash-sub">Here's your trading overview for the week</p>
        </div>
        <div className="dash-tags">
          <span className="dash-tag">{settings.defaultPair}</span>
          <span className="dash-tag strat">{settings.activeStrategy || 'No active strategy — set one on Strategies'}</span>
        </div>
      </div>

      <div className="dash-stats">
        <div className="dash-stat rise">
          <div className="stat-ic green"><DollarSign size={18} /></div>
          <div className="k">Total Balance</div>
          <div className="v">{money(balance)}</div>
        </div>
        <div className="dash-stat rise" style={{ animationDelay: '40ms' }}>
          <div className="stat-ic green"><TrendingUp size={18} /></div>
          <div className="k">Weekly P&amp;L</div>
          <div className={`v ${stats.weekPnl >= 0 ? 'up' : 'dn'}`}>{signed(stats.weekPnl)}</div>
        </div>
        <div className="dash-stat rise" style={{ animationDelay: '80ms' }}>
          <div className="stat-ic violet"><Percent size={18} /></div>
          <div className="k">Win Rate</div>
          <div className="v">{winRate}%</div>
        </div>
        <div className="dash-stat rise" style={{ animationDelay: '120ms' }}>
          <div className="stat-ic amber"><Target size={18} /></div>
          <div className="k">Open Trades</div>
          <div className="v">{stats.open}</div>
        </div>
      </div>

      <div className="dash-grid">
        <section className="panel rise">
          <div className="panel-head">
            <div className="head-col">
              <span className="panel-title">Weekly P&amp;L</span>
              <span className="panel-sub">This week's performance</span>
            </div>
          </div>
          <div className="pnl-chart">
            {stats.daily.map((v, i) => (
              <div className="pnl-col" key={DAYS[i]}>
                <div className="pnl-track">
                  <i
                    className={`pnl-bar ${v >= 0 ? 'up' : 'dn'}`}
                    style={{ height: `${Math.max((Math.abs(v) / maxDay) * 50, v === 0 ? 1 : 3)}%` }}
                  />
                </div>
                <span>{DAYS[i]}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel rise" style={{ animationDelay: '60ms' }}>
          <div className="panel-head">
            <span className="panel-title">Trading Sessions (UTC)</span>
          </div>
          <div className="sess-bars">
            {SESSION_BARS.map((s) => {
              const [a, b] = s.utc;
              return (
                <div className="sess-row" key={s.name}>
                  <b style={{ color: s.color }}>{s.name}</b>
                  <div className="sess-track">
                    <i className="sess-seg" style={{ left: `${(a / 24) * 100}%`, width: `${((b - a) / 24) * 100}%`, background: `${s.color}66` }} />
                    <i className="sess-now" style={{ left: `${(hourUtc / 24) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="kz-mini">
            <span className="kz-mini-title">Macro Kill Zones</span>
            {KILL_ZONES.map((k) => (
              <div className="kz-mini-row" key={k.name}>
                <span>{k.name}</span><b>{k.time}</b>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel rise">
        <div className="panel-head">
          <div className="head-col">
            <span className="panel-title">Recent Trades</span>
            <span className="panel-sub">This week's activity</span>
          </div>
          <Link to="/history" className="view-all">View All</Link>
        </div>
        {stats.recent.length === 0 ? (
          <div className="empty">No trades this week</div>
        ) : (
          <table className="watch">
            <thead>
              <tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Pips</th><th>P&amp;L</th><th>Closed</th></tr>
            </thead>
            <tbody>
              {stats.recent.map((t) => {
                const dec = engine.getState(t.symbol)?.decimals ?? 5;
                return (
                  <tr key={t.id}>
                    <td><b>{t.symbol}</b></td>
                    <td className={t.side === 'BUY' ? 'up' : 'dn'}>{t.side}</td>
                    <td className="num">{fmt(t.entry, dec)}</td>
                    <td className="num">{fmt(t.exit, dec)}</td>
                    <td className={`num ${t.pips >= 0 ? 'up' : 'dn'}`}>{t.pips > 0 ? '+' : ''}{t.pips}</td>
                    <td className={`num ${t.pnl >= 0 ? 'up' : 'dn'}`}>{signed(t.pnl)}</td>
                    <td className="dim">{new Date(t.closedAt).toISOString().slice(5, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
