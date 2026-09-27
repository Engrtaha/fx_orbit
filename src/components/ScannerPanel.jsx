import { useEffect, useState } from 'react';
import { Zap, Clock3, Flame } from 'lucide-react';
import { SESSIONS, fmt, sessionOpen, volatilityPips } from '../data/marketEngine';
import { Badges, signalClass } from './shared';

function momFill(momentum) {
  const pos = Math.max(-1, Math.min(1, momentum / 0.08));
  return pos >= 0
    ? { left: '50%', width: `${pos * 50}%`, background: 'linear-gradient(90deg, rgba(45,212,167,0.25), #2dd4a7)' }
    : { left: `${50 + pos * 50}%`, width: `${-pos * 50}%`, background: 'linear-gradient(90deg, #fb4b6a, rgba(251,75,106,0.25))' };
}

function SignalScanner({ pairs, onSelect }) {
  const sorted = [...pairs].sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum)).slice(0, 6);
  return (
    <div className="panel rise" style={{ animationDelay: '180ms' }}>
      <div className="panel-title">
        <Zap size={14} />
        Signal Scanner
        <span className="tag">MOMENTUM · RSI-14</span>
      </div>
      {sorted.map((p, i) => (
        <div key={p.symbol} className="scan-row" onClick={() => onSelect(p.symbol)}
          style={{ cursor: 'pointer' }}
          title={`Confidence ${p.confidence}%`}>
          <div className="scan-row-top">
            <span className="scan-rank">{String(i + 1).padStart(2, '0')}</span>
            <Badges base={p.base} quote={p.quote} size={20} />
            <span className="scan-sym">{p.symbol}</span>
            <span className="scan-rsi">RSI {fmt(p.rsi, 0)}</span>
          </div>
          <span className={signalClass(p.signal)}>{p.signal}</span>
          <div className="mom-track">
            <div className="mom-fill" style={momFill(p.momentum)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Sessions() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const hour = now.getUTCHours();
  const fmtH = (h) => `${String(h).padStart(2, '0')}:00`;
  return (
    <div className="panel rise" style={{ animationDelay: '240ms' }}>
      <div className="panel-title">
        <Clock3 size={14} />
        Market Sessions
        <span className="tag">UTC {fmtH(hour)}</span>
      </div>
      {SESSIONS.map((s) => {
        const open = sessionOpen(s, hour);
        return (
          <div key={s.name} className="session-row">
            <span className="session-name">{s.name}</span>
            <span className="session-hours">{fmtH(s.utc[0])} – {fmtH(s.utc[1])}</span>
            <span className={`session-status ${open ? 'open' : 'closed'}`}>
              {open ? '● OPEN' : 'CLOSED'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Volatility({ pairs }) {
  const ranked = pairs.map((p) => ({ ...p, vol: volatilityPips(p) }));
  const sorted = ranked.sort((a, b) => b.vol - a.vol);
  const max = Math.max(...sorted.map((p) => p.vol), 1);
  return (
    <div className="panel rise" style={{ animationDelay: '300ms' }}>
      <div className="panel-title">
        <Flame size={14} />
        Volatility Heat
        <span className="tag">AVG RANGE · 20 CANDLES</span>
      </div>
      {sorted.map((p) => (
        <div key={p.symbol} className="vol-row">
          <span className="vol-name">{p.symbol}</span>
          <div className="vol-track">
            <div className="vol-fill" style={{ width: `${(p.vol / max) * 100}%` }} />
          </div>
          <span className="vol-val">{fmt(p.vol, 1)}p</span>
        </div>
      ))}
    </div>
  );
}

export default function ScannerPanel({ pairs, onSelect }) {
  return (
    <div className="scanner-col">
      <SignalScanner pairs={pairs} onSelect={onSelect} />
      <Sessions />
      <Volatility pairs={pairs} />
    </div>
  );
}
