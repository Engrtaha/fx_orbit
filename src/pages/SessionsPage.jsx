import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { marketClosed, reopenLabel } from '../data/marketEngine';

const SESSIONS = [
  {
    key: 'asian', name: 'Asian Session', short: 'Asian', utc: [0, 9], color: '#8b5cf6',
    desc: 'Low volatility, range-bound. Good for accumulation plays.',
    pairs: ['USD/JPY', 'AUD/USD', 'NZD/USD'],
  },
  {
    key: 'london', name: 'London Session', short: 'London', utc: [8, 17], color: '#2dd4a7',
    desc: 'Highest volatility. Breakout and manipulation moves common.',
    pairs: ['EUR/USD', 'GBP/USD', 'EUR/GBP'],
  },
  {
    key: 'ny', name: 'New York Session', short: 'New York', utc: [13, 22], color: '#f59e0b',
    desc: 'Major news events. Continuation or reversal from London.',
    pairs: ['EUR/USD', 'GBP/USD', 'USD/CAD'],
  },
];

const KILL_ZONES = [
  { name: 'London Open KZ', range: [7, 9], time: '07:00 – 09:00 UTC', desc: 'Manipulation sweeps before true move. Look for displacement after sweep.' },
  { name: 'NY AM Session', range: [9.5, 12], time: '09:30 – 12:00 UTC', desc: 'First delivery of NY. Ideal for continuation of London move.' },
  { name: 'NY Silver Bullet', range: [14, 15], time: '14:00 – 15:00 UTC', desc: 'High-probability 1-hour window. Look for FVG entries.' },
  { name: 'NY PM Session', range: [15, 16], time: '15:00 – 16:00 UTC', desc: 'Late day setups. Usually continuation or retracement.' },
];

const inWindow = ([a, b], h) => (a < b ? h >= a && h < b : h >= a || h < b);
const pad = (h) => `${String(h).padStart(2, '0')}:00`;

export default function SessionsPage() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

  // These are clock windows, not market state: over the weekend the tape is
  // shut even while London or New York "should" be open, so nothing on this
  // page may claim LIVE until the desk reopens.
  const closed = marketClosed(now);
  const shut = closed.closed;

  return (
    <div className="page sessions-page">
      <p className="strat-lead rise">Session times, macro kill zones &amp; optimal trading windows</p>

      <section className="panel sessions-clock rise" style={{ animationDelay: '40ms' }}>
        <div>
          <div className="k">Current UTC Time</div>
          <div className="v">{hhmm}</div>
        </div>
        <div className="session-chips">
          {SESSIONS.map((s) => {
            const live = !shut && inWindow(s.utc, hour);
            return (
              <span key={s.key} className={`sess-chip${live ? ' live' : ''}${shut ? ' shut' : ''}`} style={live ? { '--chip': s.color } : undefined}>
                {s.short}
                {live && <i />}
                {live && <b>LIVE</b>}
                {shut && <b>CLOSED</b>}
              </span>
            );
          })}
        </div>
      </section>

      {shut && (
        <div className="sess-closed rise" style={{ animationDelay: '60ms' }}>
          <Moon size={17} />
          <div>
            <b>Market closed for the weekend</b>
            <span>
              The session and kill-zone windows below are clock times only — the FX tape shut
              Friday 22:00 UTC and reopens {reopenLabel(closed.reopensAt)}. Crypto pairs trade 24/7.
            </span>
          </div>
        </div>
      )}

      <div className="session-cards">
        {SESSIONS.map((s, i) => {
          const live = !shut && inWindow(s.utc, hour);
          return (
            <section
              key={s.key}
              className={`panel session-card rise${live ? ' open' : ''}`}
              style={{ '--accent': s.color, animationDelay: `${100 + i * 60}ms` }}
            >
              <div className="sc-head">
                <i style={{ background: s.color }} />
                <b style={{ color: s.color }}>{s.name}</b>
              </div>
              <div className="sc-time">{pad(s.utc[0])} – {pad(s.utc[1])} UTC</div>
              <p className="sc-desc">{s.desc}</p>
              <div className="sc-pairs">
                {s.pairs.map((p) => <span key={p}>{p}</span>)}
              </div>
            </section>
          );
        })}
      </div>

      <section className="panel settings-section rise" style={{ animationDelay: '260ms' }}>
        <div className="panel-head">
          <span className="panel-title">Macro Kill Zones &amp; Premium Windows</span>
        </div>
        <div className="kz-list">
          {KILL_ZONES.map((kz) => (
            <div key={kz.name} className={`kz-row${!shut && inWindow(kz.range, hour) ? ' active' : ''}`}>
              <span className="kz-badge">KZ</span>
              <div className="kz-body">
                <b>{kz.name}</b>
                <span>{kz.desc}</span>
              </div>
              <span className="kz-time">{kz.time}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
