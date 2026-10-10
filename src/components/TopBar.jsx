import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Globe, Moon } from 'lucide-react';
import { SESSIONS, fmt, marketClosed, reopenLabel, sessionOpen } from '../data/marketEngine';
import { getTvStatus, subscribeTvStatus } from '../data/tvClient';
import { Badges, Delta } from './shared';

export default function TopBar({ pairs, selected, eyebrow = 'FxOrbit Terminal', title = 'Market Analysis' }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [tv, setTv] = useState(() => getTvStatus());
  const navigate = useNavigate();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => subscribeTvStatus(setTv), []);

  // The badge used to be decoration; it has to report the feed the prices
  // actually came from, otherwise a dead bridge looks like a live terminal.
  const live = pairs.some((p) => p.tv);
  const closed = marketClosed();
  const feedHint = closed.closed
    ? `Market is closed for the weekend — the tape holds Friday's last print. It reopens ${reopenLabel(closed.reopensAt)}.`
    : live
      ? `TradingView bridge is streaming quotes on ${tv.url}`
      : tv.state === 'connecting' || tv.state === 'open'
        ? `Bridge reachable at ${tv.url} — waiting for the first candles`
        : tv.state === 'idle'
          ? 'Live feed is off — turn on TradingView in Settings to stream real quotes'
          : `Bridge unreachable at ${tv.url || 'the configured URL'} — prices are simulated. Run npm run dev, or fix the backend URL in Settings.`;

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return pairs.filter((p) => p.symbol.includes(q) || p.base.includes(q) || p.quote.includes(q)).slice(0, 6);
  }, [query, pairs]);

  const openSessions = SESSIONS.filter((s) => sessionOpen(s, now.getUTCHours()))
    .map((s) => s.name);

  const utc = now.toISOString().slice(11, 19);

  const pick = (symbol) => {
    navigate('/charts', { state: { symbol } });
    setQuery('');
  };

  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>

      <div className="searchbox">
        <Search size={15} />
        <input
          placeholder="Search instruments — EUR/USD, Gold, US100…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {focused && results.length > 0 && (
          <div className="search-drop">
            {results.map((p) => (
              <div
                key={p.symbol}
                className="search-item"
                onMouseDown={() => pick(p.symbol)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <Badges base={p.base} quote={p.quote} size={22} />
                  <b>{p.symbol}</b>
                  <span style={{ color: 'var(--faint)', fontSize: 11 }}>{p.group}</span>
                </span>
                <Delta value={p.changePct} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="topbar-right">
        <div className="session-chip">
          <Globe size={13} />
          <span>
            {closed.closed ? (
              <>Market closed · <b>reopens {reopenLabel(closed.reopensAt)}</b></>
            ) : openSessions.length > 0 ? (
              <><b>{openSessions.join(' · ')}</b> session{openSessions.length > 1 ? 's' : ''} live</>
            ) : (
              'Markets transitioning'
            )}
          </span>
        </div>

        <div className="clock-chip">
          <span className="t">{utc}</span>
          <span className="s">UTC Time</span>
        </div>

        <div className={`live-badge${closed.closed ? ' closed' : live ? '' : ' sim'}`} title={feedHint}>
          {closed.closed ? <Moon size={12} /> : <span className="live-dot" />}
          {closed.closed ? 'CLOSED' : live ? 'LIVE' : 'SIM'}
        </div>

        {selected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Badges base={selected.base} quote={selected.quote} size={26} />
            <div>
              <div className="num" style={{ fontSize: 13, fontWeight: 600 }}>
                {fmt(selected.mid, selected.decimals)}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '0.08em' }}>
                {selected.symbol} MID
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
