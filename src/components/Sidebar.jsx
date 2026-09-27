import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Zap, History, Newspaper, Brain, Settings,
} from 'lucide-react';

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', to: '/' },
  { icon: Zap, label: 'Signals', to: '/signals' },
  { icon: History, label: 'History', to: '/history' },
  { icon: Newspaper, label: 'News', to: '/news' },
  { icon: Brain, label: 'Strategies', to: '/strategies' },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <NavLink to="/" className="logo-mark" title="FxOrbit">
        <svg viewBox="0 0 48 48" fill="none">
          <defs>
            <linearGradient id="lg-core" x1="0" y1="0" x2="48" y2="48">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#8b5cf6" />
            </linearGradient>
            <linearGradient id="lg-ring" x1="0" y1="0" x2="48" y2="0">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.4" />
            </linearGradient>
          </defs>
          <circle cx="24" cy="24" r="6.5" fill="url(#lg-core)" />
          <g className="ring">
            <ellipse cx="24" cy="24" rx="17.5" ry="7.5" stroke="url(#lg-ring)" strokeWidth="1.4"
              transform="rotate(-24 24 24)" strokeDasharray="3 4" strokeLinecap="round" />
            <circle cx="38.5" cy="17.5" r="2" fill="#22d3ee" />
          </g>
          <g className="ring2">
            <ellipse cx="24" cy="24" rx="17.5" ry="7.5" stroke="rgba(139,92,246,0.55)" strokeWidth="1.1"
              transform="rotate(28 24 24)" strokeDasharray="2 5" strokeLinecap="round" />
          </g>
        </svg>
      </NavLink>

      {NAV.map(({ icon: Icon, label, to }) => (
        <NavLink
          key={label}
          to={to}
          end={to === '/'}
          className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}
          title={label}
          aria-label={label}
        >
          <Icon size={20} strokeWidth={1.8} />
        </NavLink>
      ))}

      <div className="sidebar-spacer" />
      <NavLink to="/settings" className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`} title="Settings" aria-label="Settings">
        <Settings size={20} strokeWidth={1.8} />
      </NavLink>
      <div className="avatar" title="Trader">TA</div>
    </aside>
  );
}
