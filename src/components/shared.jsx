import { useId } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { ccyGradient } from '../data/marketEngine';

export function Badges({ base, quote, size = 24 }) {
  return (
    <span className="badges">
      {[base, quote].map((code) => {
        const [c1, c2] = ccyGradient(code);
        return (
          <span
            key={code}
            className="badge"
            style={{ width: size, height: size, background: `linear-gradient(135deg, ${c1}, ${c2})` }}
          >
            {code.slice(0, code === 'XAU' || code === 'XAG' ? 2 : 2)}
          </span>
        );
      })}
    </span>
  );
}

export function Delta({ value, suffix = '%', arrow = true }) {
  const up = value >= 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {arrow && (up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />)}
      {up ? '+' : ''}
      {value.toFixed(2)}
      {suffix}
    </span>
  );
}

export function FlatDir({ dir }) {
  if (dir > 0) return <ArrowUpRight size={12} className="num up" style={{ display: 'inline' }} />;
  if (dir < 0) return <ArrowDownRight size={12} className="num down" style={{ display: 'inline' }} />;
  return <Minus size={12} color="var(--faint)" />;
}

export function Sparkline({ data, width = 92, height = 30, positive }) {
  const id = useId().replace(/:/g, '');
  if (!data || data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - 2) + 1;
    const y = height - 2.5 - ((v - min) / range) * (height - 5);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const color = positive ? 'var(--green)' : 'var(--red)';
  return (
    <svg width={width} height={height} className="pair-card-spark">
      <defs>
        <linearGradient id={`sg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`${pts.join(' ')} ${width - 1},${height} 1,${height}`} fill={`url(#sg${id})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function signalClass(sig) {
  return `sig sig-${sig.toLowerCase().replace(' ', '-')}`;
}
