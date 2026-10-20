import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { seedStorage } from './setup.js';

// Every page rendered the way the browser first paints it, against seeded data:
// a $126 account started at a known moment, a reversal book at 1:4.5 held 6h,
// one live signal, and an archive with an old oversized trade that must stay
// out of the balance. Effects do not run in a server render, so this checks
// what each page draws from state — the numbers this release changed — not
// its timers or network calls.
const ACCOUNT_START = Date.now() - 3600e3;
const book = {
  id: 's-rev', title: 'Liquidity Sweep Reversal', pair: 'XAU/USD',
  analysis: ['Fade sweeps at range extremes.'],
  entryRules: ['Sell the sweep of buy-side liquidity'],
  riskRules: ['Stop beyond the sweep wick'],
  origin: 'manual', parents: [], timeframes: ['15m'], armed: false, simulated: false,
  directions: ['bear'], rr: 4.5, holdHours: 6, setup: 'reversal',
  createdAt: Date.now(), updatedAt: Date.now(),
};
seedStorage({
  pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'XAU/USD',
  initialBalance: 126, riskPerTrade: 2, accountSince: ACCOUNT_START,
  activeStrategyId: book.id, activeStrategy: book.title, activeStrategyData: book,
});
localStorage.setItem('fxorbit-strategies', JSON.stringify([book]));
localStorage.setItem('fxorbit-signals', JSON.stringify({
  active: [{
    id: 'SIG-1', symbol: 'XAU/USD', tf: '15m', side: 'SHORT', entry: 2400, sl: 2410, tp: 2355,
    slPips: 100, tpPips: 450, rr: 4.5, confidence: 70, summary: '', mode: 'my', decimals: 2,
    strategyRules: { name: book.title, rules: '', rr: 4.5, holdHours: 6, setup: 'reversal' },
    reversal: { side: 'SHORT', kind: 'sweep', label: 'Bearish liquidity-sweep reversal' },
    createdAt: Date.now(), expiresAt: Date.now() + 6 * 3600e3,
  }],
  closed: [],
}));

const { engine } = await import('../src/data/marketEngine.js');
engine.start();
clearInterval(engine.timer);
engine.timer = null;
engine.loadTrades([
  // Booked before the account started: the old flat-0.1-lot loss stays in History only.
  { id: 'T-916', symbol: 'US100', side: 'BUY', status: 'closed', lots: 0.1, entry: 24000, sl: 23762, tp: 24595, exit: 23762, pips: -237.5, pnl: -237.5, exitReason: 'SL Hit', openedAt: ACCOUNT_START - 7200e3, closedAt: ACCOUNT_START - 3600e3 },
  { id: 'T-1100', symbol: 'XAU/USD', side: 'SELL', status: 'closed', lots: 0.0025, entry: 2400, sl: 2410, tp: 2355, exit: 2355, pips: 450, pnl: 11.25, exitReason: 'TP Hit', openedAt: ACCOUNT_START + 60e3, closedAt: ACCOUNT_START + 600e3 },
]);

const render = async (path, file) => {
  const { default: Page } = await import(`../src/pages/${file}.jsx`);
  return renderToString(<MemoryRouter initialEntries={[path]}><Page /></MemoryRouter>);
};
// React interleaves text with comment markers; compare against the plain text.
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('pages render against seeded state', () => {
  it('Portfolio counts only the current account', async () => {
    const t = text(await render('/portfolio', 'PortfolioPage'));
    expect(t).toContain('$137.25');            // 126 + 11.25 — the -$237.50 is before the start
    expect(t).not.toContain('237.50');
    expect(t).toContain('1W / 0L of 1 closed');
    expect(t).toContain('XAU/USD · +$11.25');  // best trade
  });

  it('Dashboard shows the same balance as Portfolio', async () => {
    expect(text(await render('/', 'DashboardPage'))).toContain('$137.25');
  });

  it('History still lists every archived trade', async () => {
    const t = text(await render('/history', 'HistoryPage'));
    expect(t).toContain('T-916');
    expect(t).toContain('T-1100');
  });

  it('Signals shows the book R:R, the reversal badge and the expiry', async () => {
    const t = text(await render('/signals', 'SignalsPage'));
    expect(t).toContain('risk:reward of 1:4.5');
    expect(t).toContain('R:R 1:4.5');
    expect(t).toContain('Reversal');
    expect(t).toMatch(/expires in (5h|6h)/);
  });

  it('Strategies shows the explicit trade fields', async () => {
    const t = text(await render('/strategies', 'StrategiesPage'));
    expect(t).toContain('Reversal · R:R 1:4.5 · hold 6h');
  });

  it('Charts, News, Sessions and Settings draw without throwing', async () => {
    expect(text(await render('/charts', 'ChartsPage'))).toContain('XAU/USD');
    expect(text(await render('/news', 'NewsPage'))).toContain('Analyze a news screenshot');
    expect(text(await render('/sessions', 'SessionsPage')).length).toBeGreaterThan(100);
    const settings = text(await render('/settings', 'SettingsPage'));
    expect(settings).toContain('AI Model Integration');
    expect(settings).not.toContain('Unsaved'); // nothing edited yet
  });
});
