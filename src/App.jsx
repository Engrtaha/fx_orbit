import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import DashboardPage from './pages/DashboardPage';
import SignalsPage from './pages/SignalsPage';
import HistoryPage from './pages/HistoryPage';
import NewsPage from './pages/NewsPage';
import StrategiesPage from './pages/StrategiesPage';
import SettingsPage from './pages/SettingsPage';
import { engine } from './data/marketEngine';

const TITLES = {
  '/': { eyebrow: 'FxOrbit Terminal', title: 'Market Analysis' },
  '/signals': { eyebrow: 'Signal Engine', title: 'Trade Signals' },
  '/history': { eyebrow: 'Performance', title: 'Trade History' },
  '/news': { eyebrow: 'Desk Feed', title: 'News & AI Vision' },
  '/strategies': { eyebrow: 'Systems', title: 'Strategies' },
  '/settings': { eyebrow: 'Configuration', title: 'Settings' },
};

function Layout() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [symbol, setSymbol] = useState('EUR/USD');
  const [pending, setPending] = useState(null);
  const location = useLocation();

  useEffect(() => {
    const unsub = engine.subscribe(setPairs);
    engine.start();
    return unsub;
  }, []);

  const selected = pairs.find((p) => p.symbol === symbol) ?? pairs[0];
  const handleSelect = (sym, viaNav = false) => {
    if (viaNav) setPending(sym);
    else setSymbol(sym);
  };
  const t = TITLES[location.pathname] ?? TITLES['/'];

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <TopBar pairs={pairs} selected={selected} onSelect={handleSelect} eyebrow={t.eyebrow} title={t.title} />
        <Routes>
          <Route path="/" element={
            <DashboardPage pairs={pairs} symbol={symbol} setSymbol={setSymbol} pending={pending} setPending={setPending} />
          } />
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/strategies" element={<StrategiesPage />} />
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
