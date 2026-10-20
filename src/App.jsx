import { Component, Suspense, lazy, useEffect, useState } from 'react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';

// Each page is its own chunk, loaded when first opened: the charting library
// only ships with the pages that draw charts, and the first paint no longer
// waits for all nine pages (the single bundle was ~650 kB).
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SignalsPage = lazy(() => import('./pages/SignalsPage'));
const ChartsPage = lazy(() => import('./pages/ChartsPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const NewsPage = lazy(() => import('./pages/NewsPage'));
const StrategiesPage = lazy(() => import('./pages/StrategiesPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const SessionsPage = lazy(() => import('./pages/SessionsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
import { engine } from './data/marketEngine';
import { loadSettings, subscribeSettings } from './data/settings';
import { loadLibrary } from './data/strategyBook';
import { syncTvFeed } from './data/tvClient';
import { tickSignals } from './data/signalEngine';
import { startTradeSync } from './data/persistence';

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

// One broken page must not blank the terminal. Without this, any throw during a
// render (a corrupt archived row, a half-written localStorage record) unmounts the
// whole tree and the user sees an empty white window with no way back.
class PageBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <section className="panel page-crash">
          <b>This page could not be drawn</b>
          <span>{String(this.state.error?.message ?? this.state.error)}</span>
          <p>
            The rest of the terminal still works — open another page, or reload if the
            message came back. Settings → Reset preferences clears a bad saved value.
          </p>
        </section>
      </div>
    );
  }
}

function Layout() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const location = useLocation();

  useEffect(() => {
    const unsub = engine.subscribe(setPairs);
    engine.start();
    engine.syncStrategies(loadLibrary()); // armed books trade even if the page is never opened
    syncTvFeed();
    const unsubSettings = subscribeSettings(() => syncTvFeed());
    const sigTimer = setInterval(() => { void tickSignals(); }, 1000);
    const stopTradeSync = startTradeSync();
    return () => {
      unsub();
      unsubSettings();
      clearInterval(sigTimer);
      stopTradeSync();
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
        {/* keyed by route so navigating away from a failed page clears its error */}
        <PageBoundary key={location.pathname}>
          <Suspense fallback={<div className="page"><p className="dim empty">Loading…</p></div>}>
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
          </Suspense>
        </PageBoundary>
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
