import { describe, expect, it, vi } from 'vitest';
import { seedStorage } from './setup.js';

// Seed before importing: the engine constructor and loadSettings read localStorage.
seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
const { engine } = await import('../src/data/marketEngine.js');
const mod = await import('../src/data/newsEngine.js');

engine.start();
clearInterval(engine.timer);
engine.timer = null; // keep prices frozen so assertions stay deterministic
engine.markAllTv(true); // the desk only places trades on a live feed

const now = () => Math.floor(Date.now() / 1000);
const headline = (over = {}) => ({
  id: `n-${Math.random().toString(36).slice(2, 8)}`,
  feed: 'news', kind: 'news', time: now() - 600,
  title: 'Swiss Franc: Range trading persists against the US Dollar',
  summary: 'The bank notes the pair remains in a tight range around 0.8300.',
  impact: 'medium', ...over,
});

describe('universe scoping', () => {
  it('maps enabled pairs to their currency codes', () => {
    const ccys = mod.universeCurrencies();
    expect([...ccys].sort()).toEqual(['EUR', 'USD', 'XAU']);
    expect([...mod.universeCurrencies(['JP225', 'XAG/USD'])].sort()).toEqual(['JPY', 'USD', 'XAG']);
  });

  it('keeps calendar items by currency and headlines by tagged currencies', () => {
    const ccys = mod.universeCurrencies();
    expect(mod.itemInUniverse({ feed: 'calendar', currency: 'USD' }, ccys)).toBe(true);
    expect(mod.itemInUniverse({ feed: 'calendar', currency: 'JPY' }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news', currencies: ['CAD'] }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news', currencies: ['XAU'] }, ccys)).toBe(true);
  });

  it('hides untagged headlines while scoped, shows everything unscoped', () => {
    const ccys = mod.universeCurrencies();
    expect(mod.itemInUniverse({ feed: 'news' }, ccys)).toBe(false);
    expect(mod.itemInUniverse({ feed: 'news' }, new Set())).toBe(true);
  });
});

describe('desk heuristic (via analyzeItem)', () => {
  it('never trades a currency the enabled instruments do not carry', async () => {
    // This used to SELL US100 — a CAD story on a desk with no CAD pair.
    const a = await mod.analyzeItem(headline({
      title: 'Canadian Dollar falls to near 18-month lows as oil prices decline',
      summary: 'The loonie slid for a third session.',
    }));
    expect(a.impact).toBe('medium');
    expect(a.sentiment).toBe('bearish');
    expect(a.subject).toEqual({ ccy: 'CAD' });
    expect(a.trade).toBeNull();
    expect(a.read.direction).toBe('neutral');
  });

  it('reads the subject of the headline, not the other currency in it', async () => {
    // currencies[0] made this a USD story, flipped through XAU/USD's quote: BULLISH gold.
    const a = await mod.analyzeItem(headline({
      title: 'Gold falls as dollar strengthens on hot jobs data',
      currencies: ['USD', 'XAU'],
    }));
    expect(a.subject).toEqual({ ccy: 'XAU' });
    expect(a.sentiment).toBe('bearish');
    expect(a.read).toEqual({ symbol: 'XAU/USD', direction: 'bearish' });
    expect(a.trade.side).toBe('SELL');
    expect(a.trade.sl).toBeGreaterThan(a.trade.entry);
    expect(a.trade.tp).toBeLessThan(a.trade.entry);
    expect(a.trade.rr).toBeCloseTo(a.trade.tpPips / a.trade.slPips, 2);
    expect(a.simulated).toBe(true);
  });

  it('trades an instrument the headline names outright, in its own direction', async () => {
    const a = await mod.analyzeItem(headline({ title: 'EUR/USD slides after ECB signals deeper cuts' }));
    expect(a.subject).toEqual({ symbol: 'EUR/USD' });
    expect(a.read).toEqual({ symbol: 'EUR/USD', direction: 'bearish' });
    expect(a.trade.side).toBe('SELL');
  });

  it('does not treat "against" as the GAIN keyword (word boundaries)', async () => {
    const a = await mod.analyzeItem(headline());
    expect(a.sentiment).toBe('neutral');
    expect(a.trade).toBeNull();
    expect(a.summary).toContain('stands aside');
  });

  it('stands aside on low-impact items even with strong wording', async () => {
    const a = await mod.analyzeItem(headline({
      impact: 'low',
      title: 'Gold surges to a record high as demand explodes',
    }));
    expect(a.impact).toBe('low');
    expect(a.trade).toBeNull();
    expect(a.summary).toContain('tradable threshold');
  });

  it('uses a shorter horizon for high-impact reads', async () => {
    const a = await mod.analyzeItem(headline({
      impact: 'high',
      title: 'Dollar tumbles as traders price deeper rate cuts',
    }));
    // Bearish for the DOLLAR, which is bullish for a USD-quoted instrument.
    expect(a.sentiment).toBe('bearish');
    expect(a.subject).toEqual({ ccy: 'USD' });
    expect(a.read).toEqual({ symbol: 'US100', direction: 'bullish' });
    expect(a.trade.side).toBe('BUY');
    expect(a.trade.horizon).toBe('hours');
  });

  it('maps a USD-calendar beat through quote direction — hot CPI is bearish US100', async () => {
    const a = await mod.analyzeItem({
      id: 'cal-1', feed: 'calendar', kind: 'calendar', time: now() - 60,
      title: 'CPI y/y', currency: 'USD', impact: 'high',
      actual: 3.4, estimate: 3.1, previous: 3.0, unit: '%',
    });
    expect(a.currencies).toContain('USD');
    expect(a.sentiment).toBe('bullish');
    expect(a.read).toEqual({ symbol: 'US100', direction: 'bearish' });
    expect(a.trade.side).toBe('SELL');
    expect(a.trade.sl).toBeGreaterThan(a.trade.tp);
    expect(a.summary).toContain('above consensus');
    expect(a.summary).toContain('BEARISH for US100');
  });

  it('scores unemployment and jobless claims the other way round', async () => {
    const jobless = await mod.analyzeItem({
      id: 'cal-3', feed: 'calendar', kind: 'calendar', time: now() - 60,
      title: 'Unemployment Rate', currency: 'USD', impact: 'high',
      actual: '4.5%', estimate: '4.2%', previous: '4.2%',
    });
    expect(jobless.sentiment).toBe('bearish'); // more unemployed is bad for USD
    expect(jobless.read).toEqual({ symbol: 'US100', direction: 'bullish' });
    expect(jobless.summary).toContain('higher print is bad news');

    const claims = await mod.analyzeItem({
      id: 'cal-4', feed: 'calendar', kind: 'calendar', time: now() - 60,
      title: 'Initial Jobless Claims', currency: 'USD', impact: 'medium',
      actual: '215K', estimate: '230K',
    });
    expect(claims.sentiment).toBe('bullish');
    expect(mod.figure('215K')).toBe(215000);
    expect(mod.figure('-0.3%')).toBe(-0.3);
    expect(mod.figure('n/a')).toBeNull();
  });

  it('waits on an event with no numbers and no directional tone', async () => {
    const a = await mod.analyzeItem({
      id: 'cal-2', feed: 'calendar', kind: 'calendar', time: now() + 3600,
      title: 'FOMC Member Waller Speaks', currency: 'USD', impact: 'medium',
    });
    expect(a.trade).toBeNull();
    expect(a.sentiment).toBe('neutral');
  });
});

describe('pair direction (quote-currency mapping)', () => {
  it('flips the tone when it is about the quote currency', () => {
    const item = { currencies: ['USD'] };
    expect(mod.pairDirectionOf('bearish', item, 'XAU/USD')).toEqual({ symbol: 'XAU/USD', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'EUR/USD')).toEqual({ symbol: 'EUR/USD', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'US100')).toEqual({ symbol: 'US100', direction: 'bullish' });
    expect(mod.pairDirectionOf('bearish', item, 'USD/JPY')).toEqual({ symbol: 'USD/JPY', direction: 'bearish' });
    expect(mod.pairDirectionOf('bullish', item, 'XAU/USD').direction).toBe('bearish');
  });

  it('says nothing about an instrument that does not carry the subject', () => {
    expect(mod.pairDirectionOf('bullish', { currencies: ['CAD'] }, 'XAU/USD').direction).toBe('neutral');
    expect(mod.pairDirectionOf('bearish', { title: 'Yen slumps' }, 'EUR/USD').direction).toBe('neutral');
    expect(mod.pairDirectionOf('bearish', { title: 'Yen slumps' }, 'USD/JPY').direction).toBe('bullish');
  });

  it('finds the subject from names as well as codes, in reading order', () => {
    expect(mod.subjectOf({ title: 'Gold falls as dollar strengthens' })).toEqual({ ccy: 'XAU' });
    expect(mod.subjectOf({ title: 'Dollar firms while gold slips' })).toEqual({ ccy: 'USD' });
    expect(mod.subjectOf({ title: 'Canadian dollar extends losses' })).toEqual({ ccy: 'CAD' });
    expect(mod.subjectOf({ title: 'Nasdaq hits record on chip rally' })).toEqual({ symbol: 'US100' });
    expect(mod.subjectOf({ title: 'Stocks at a decade high in European trade' })).toEqual({});
    expect(mod.subjectOf({ feed: 'calendar', currency: 'gbp', title: 'CPI y/y' })).toEqual({ ccy: 'GBP' });
  });

  it('keeps the raw tone for base-currency or untagged items', () => {
    expect(mod.pairDirectionOf('bullish', { currencies: ['EUR'] }, 'EUR/USD').direction).toBe('bullish');
    expect(mod.pairDirectionOf('bearish', {}, 'XAU/USD').direction).toBe('bearish');
    expect(mod.pairDirectionOf('neutral', { currencies: ['USD'] }, 'XAU/USD').direction).toBe('neutral');
    expect(mod.pairDirectionOf('bullish', { currencies: ['USD'] }, null).direction).toBe('neutral');
  });
});

describe('desk trade book', () => {
  it('places, tracks and desk-closes a news trade', async () => {
    const item = headline({ title: 'Gold demand strong as buyers step in' });
    const plan = await mod.analyzeItem(item);
    expect(plan.trade.side).toBe('BUY');

    const t = mod.placeNewsTrade(plan.trade, item);
    expect(t.source).toBe('News AI');
    expect(t.maxHoldMs).toBe(mod.newsHoldMs(plan.trade.horizon)); // held for the planned horizon
    expect(mod.newsHoldMs('1-3 days')).toBe(72 * 3600e3);
    expect(mod.newsHoldMs('hours')).toBe(8 * 3600e3);
    expect(t.status).toBe('open');
    expect(t.note).toContain('Gold demand strong');
    expect(mod.newsTrades().open).toHaveLength(1);

    expect(mod.closeNewsTrade(t.id)).toBe(true);
    expect(mod.closeNewsTrade(t.id)).toBe(false);
    const closed = mod.newsTrades().closed;
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('Desk Close');
  });

  it('flags high-impact news published after a trade that points the other way', async () => {
    const item = headline({ title: 'Gold demand strong as buyers step in' });
    const plan = await mod.analyzeItem(item);
    expect(plan.trade.symbol).toBe('XAU/USD'); // gold news trades gold, not the default pair
    const t = mod.placeNewsTrade(plan.trade, item);

    const items = [
      { id: 'x1', feed: 'news', title: 'Risk appetite surges', time: now() + 10, currencies: ['USD'] },
      { id: 'x2', feed: 'news', title: 'Recession fears deepen', time: now() + 20, currencies: ['USD'] },
      { id: 'x3', feed: 'news', title: 'Recession fears deepen', time: now() - 900, currencies: ['USD'] },
      { id: 'x4', feed: 'news', title: 'Recession fears deepen', time: now() + 30, currencies: ['JPY'] },
    ];
    const analyses = {
      x1: { impact: 'high', sentiment: 'bullish' },
      x2: { impact: 'high', sentiment: 'bearish' },
      x3: { impact: 'high', sentiment: 'bearish' },
      x4: { impact: 'high', sentiment: 'bearish' },
    };
    // Long XAU/USD: bullish-USD news (x1) is the threat; bearish-USD news (x2)
    // supports the trade and used to be flagged by mistake.
    const flags = mod.riskFlags(t, items, analyses);
    expect(flags.map((f) => f.itemId)).toEqual(['x1']);
  });
});

describe('vision prose fallback', () => {
  it('tiers a captioning model transcription into a desk read', () => {
    // Moondream-class vision models read a screenshot faithfully but answer in
    // prose, so the JSON contract is gone. NewsPage feeds the quoted headline
    // and the transcription to the desk heuristic instead of discarding the
    // read — this pins that deskAnalysis accepts that shape.
    const text = 'The image shows a blue banner with white text that reads "US INFLATION SURPRISES HIGHER '
      + 'CPI Rises 3.4% vs 3.1% expected - Fed rate path in focus". The text is in black against the banner.';
    const quoted = text.match(/[""]([^""]{8,160})[""]/)?.[1];
    expect(quoted).toContain('INFLATION');
    const read = mod.deskAnalysis({ title: quoted, summary: text });
    expect(read.impact).toBe('high');
    expect(read.sentiment).toBe('bullish'); // "HIGHER" is the only tone hit in the title
    expect(read.confidence).toBeGreaterThanOrEqual(40);
    expect(read.confidence).toBeLessThanOrEqual(92);
    expect(read.summary).toContain(quoted.slice(0, 20));
    expect(read.simulated).toBe(true);
  });
});

describe('AI analyst normalization', () => {
  it('derives the pair side from the subject tone when the model flips it wrong', async () => {
    seedStorage({
      pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100',
      aiProvider: 'ollama', aiModel: '', aiBaseUrl: 'http://localhost:11434',
    });
    const reply = {
      subject: 'USD', impact: 'high', sentiment: 'bearish', confidence: 70, summary: 'Soft data weighs on the dollar.',
      // Bearish USD is bullish XAU/USD — the classic small-model mistake:
      trade: { symbol: 'XAU/USD', side: 'SELL', slPips: 40, tpPips: 80, horizon: 'hours' },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(reply) } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const a = await mod.analyzeItem(headline({ title: 'US retail sales miss forecasts', impact: 'high' }));
      expect(a.simulated).toBe(false);
      expect(a.read).toEqual({ symbol: 'XAU/USD', direction: 'bullish' });
      expect(a.trade.side).toBe('BUY');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:11434/v1/chat/completions'); // /v1 added
      const body = JSON.parse(init.body);
      expect(body.model).toBe('llama3.2:latest'); // not gpt-4o-mini
      expect(body.response_format).toEqual({ type: 'json_object' });
    } finally {
      vi.unstubAllGlobals();
      seedStorage({ pairs: ['US100', 'XAU/USD', 'EUR/USD'], defaultPair: 'US100' });
    }
  });
});
