import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import DashboardPage from './pages/DashboardPage';
import SignalsPage from './pages/SignalsPage';
import ChartsPage from './pages/ChartsPage';
import HistoryPage from './pages/HistoryPage';
import NewsPage from './pages/NewsPage';
import StrategiesPage from './pages/StrategiesPage';
import PortfolioPage from './pages/PortfolioPage';
import SessionsPage from './pages/SessionsPage';
import SettingsPage from './pages/SettingsPage';
import { engine } from './data/marketEngine';
import { loadSettings, subscribeSettings } from './data/settings';
import { syncTvFeed } from './data/tvClient';
import { tickSignals } from './data/signalEngine';

const TITLES = {
  '/': { eyebrow: 'Overview', title: 'Dashboard' },
  '/signals': { eyebrow: 'Signal Engine', title: 'Trade Signals' },
  '/charts': { eyebrow: 'Price Action', title: 'Market Charts' },
  '/history': { eyebrow: 'Performance', title: 'Trade History' },
  '/news': { eyebrow: 'Desk Feed', title: 'News Analysis' },
  '/strategies': { eyebrow: 'Systems', title: 'Trading Strategy' },
  '/portfolio': { eyebrow: 'Account', title: 'Portfolio' },
  '/sessions': { eyebrow: 'Market Hours', title: 'Trading Sessions' },
  '/settings': { eyebrow: 'Configuration', title: 'Settings' },
};

function Layout() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const location = useLocation();

  useEffect(() => {
    const unsub = engine.subscribe(setPairs);
    engine.start();
    syncTvFeed();
    const unsubSettings = subscribeSettings(() => syncTvFeed());
    const sigTimer = setInterval(() => { void tickSignals(); }, 1000);
    return () => {
      unsub();
      unsubSettings();
      clearInterval(sigTimer);
    };
  }, []);

  const { defaultPair } = loadSettings();
  const selected = pairs.find((p) => p.symbol === defaultPair) ?? pairs[0];
  const t = TITLES[location.pathname] ?? TITLES['/'];

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <TopBar pairs={pairs} selected={selected} eyebrow={t.eyebrow} title={t.title} />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/charts" element={<ChartsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/strategies" element={<StrategiesPage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Layout />
    </HashRouter>
  );
}
