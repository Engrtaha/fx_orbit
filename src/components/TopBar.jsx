import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Globe } from 'lucide-react';
import { SESSIONS, fmt, sessionOpen } from '../data/marketEngine';
import { Badges, Delta } from './shared';

export default function TopBar({ pairs, selected, onSelect, eyebrow = 'FxOrbit Terminal', title = 'Market Analysis' }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return pairs.filter((p) => p.symbol.includes(q) || p.base.includes(q) || p.quote.includes(q)).slice(0, 6);
  }, [query, pairs]);

  const openSessions = SESSIONS.filter((s) => sessionOpen(s, now.getUTCHours()))
    .map((s) => s.name);

  const utc = now.toISOString().slice(11, 19);

  const pick = (symbol) => {
    if (location.pathname !== '/') {
      onSelect(symbol, true);
      navigate('/');
    } else {
      onSelect(symbol);
    }
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
            {openSessions.length > 0 ? (
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

        <div className="live-badge">
          <span className="live-dot" />
          LIVE
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
