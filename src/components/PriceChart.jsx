import { useEffect, useRef, useState } from 'react';
import {
  createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode,
} from 'lightweight-charts';
import { Activity, Timer } from 'lucide-react';
import {
  TIMEFRAMES, barCloseIn, engine, findReversals, fmt, symbolMarketClosed, tfPeriodMs, volatilityPips,
} from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import { fetchTvHistory } from '../data/tvClient';
import { chartCapture } from '../data/chartCapture';
import { Badges, Delta } from './shared';

const UP = 'rgba(45, 212, 167, 0.32)';
const DOWN = 'rgba(251, 75, 106, 0.32)';

// One arrow per reversal print on a closed bar: down-arrows above swept highs,
// up-arrows below swept lows. "SWP" = liquidity sweep, "RSI" = RSI exhaustion.
const reversalMarkers = (bars) => findReversals(bars).map((r) => ({
  time: r.time,
  position: r.side === 'SHORT' ? 'aboveBar' : 'belowBar',
  shape: r.side === 'SHORT' ? 'arrowDown' : 'arrowUp',
  color: r.side === 'SHORT' ? '#fb4b6a' : '#2dd4a7',
  text: r.kind === 'sweep' ? 'SWP' : 'RSI',
}));

function emaSeries(candles, period) {
  const k = 2 / (period + 1);
  let prev;
  return candles.map((c, i) => {
    prev = i === 0 ? c.close : c.close * k + prev * (1 - k);
    return { time: c.time, value: prev };
  });
}

// "47s" for a moment, "12:04" within the hour, "2h 04m" beyond it.
const closeLabel = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

// Wall-clock countdown to the next candle close on every timeframe. The bars
// are epoch-aligned, so this needs no feed — only the tape being open, which
// for crypto pairs means always.
function BarCountdown({ symbol, tf, onTfChange }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const closed = symbolMarketClosed(symbol, new Date(now)).closed;
  return (
    <div className={`bar-close${closed ? ' shut' : ''}`}>
      <span className="bc-k">
        <Timer size={11} /> {closed ? 'Market closed — bars are paused' : 'Bar closes in'}
      </span>
      {TIMEFRAMES.map((t) => {
        const period = tfPeriodMs(t);
        const left = barCloseIn(t, now);
        return (
          <button
            key={t}
            type="button"
            className={`bc-cell${t === tf ? ' on' : ''}`}
            onClick={() => onTfChange(t)}
            title={`Show the ${t} chart`}
          >
            <span className="bc-tf">{t}</span>
            <span className="bc-time">{closed ? '—' : closeLabel(left)}</span>
            <span className="bc-bar">
              <i style={{ width: closed ? 0 : `${Math.round(((period - left) / period) * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function PriceChart({ pair, symbol, tf, onTfChange, signal }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volRef = useRef(null);
  const emaRef = useRef(null);
  const emaLastRef = useRef(null);
  const markersRef = useRef(null);
  const [reversals, setReversals] = useState(0);
  // The series holds the DISPLAYED timeframe's bars; streaming into it before
  // setData has run, or with a bar older than what it holds, makes
  // lightweight-charts throw. Both are tracked here.
  const drawnRef = useRef(false);
  const lastBarTimeRef = useRef(0);

  // create chart once
  useEffect(() => {
    const el = containerRef.current;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#55637e',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.055)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.055)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(34, 211, 238, 0.35)', width: 1, style: 2,
          labelBackgroundColor: '#1b2740',
        },
        horzLine: {
          color: 'rgba(34, 211, 238, 0.35)', width: 1, style: 2,
          labelBackgroundColor: '#1b2740',
        },
      },
      rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.12)' },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.12)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
      localization: {
        timeFormatter: (t) => {
          const d = new Date(t * 1000);
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mm = String(d.getUTCMinutes()).padStart(2, '0');
          return `${hh}:${mm}`;
        },
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#2dd4a7',
      downColor: '#fb4b6a',
      wickUpColor: '#2dd4a7',
      wickDownColor: '#fb4b6a',
      borderVisible: false,
      priceLineColor: 'rgba(34, 211, 238, 0.55)',
      priceLineStyle: 2,
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.07, bottom: 0.24 } });

    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const ema = chart.addSeries(LineSeries, {
      color: '#a78bfa',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candles;
    markersRef.current = createSeriesMarkers(candles, []);
    volRef.current = volume;
    emaRef.current = ema;
    chartCapture.fn = () => chart.takeScreenshot().toDataURL('image/png');

    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      try { chartCapture.last = chart.takeScreenshot().toDataURL('image/png'); } catch { /* chart already gone */ }
      chart.remove();
      chartRef.current = null;
      chartCapture.fn = null;
    };
  }, []);

  // load history when pair or timeframe changes; backfill real TradingView
  // history first when the live feed is enabled (falls back to simulated)
  useEffect(() => {
    let cancelled = false;
    const cs = candleRef.current;
    if (!cs) return;
    drawnRef.current = false;
    const settings = loadSettings();
    const backfill = settings.tvEnabled
      ? fetchTvHistory(settings.tvBackendUrl, symbol, tf).catch(() => 0)
      : Promise.resolve(0);

    backfill.then(() => {
      if (cancelled) return;
      const data = engine.getCandles(symbol, tf);
      const dec = engine.getState(symbol)?.decimals ?? pair.decimals;
      const minMove = 10 ** -dec;

      cs.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove } });
      cs.setData(data.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      volRef.current.setData(
        data.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? UP : DOWN }))
      );
      const ema = emaSeries(data, 20);
      emaLastRef.current = ema.length ? ema[ema.length - 1].value : null;
      emaRef.current.setData(ema);
      const marks = reversalMarkers(data);
      markersRef.current?.setMarkers(marks);
      setReversals(marks.length);
      chartRef.current.timeScale().fitContent();
      lastBarTimeRef.current = data.length ? data[data.length - 1].time : 0;
      drawnRef.current = true;
    });
    return () => { cancelled = true; };
  }, [symbol, tf, pair.decimals]);

  // stream live ticks into the active chart
  useEffect(() => {
    const unsub = engine.subscribe(() => {
      if (!drawnRef.current) return;
      // The 1m candle is NOT the bar this series holds. Streaming s.liveCandle
      // into a 15m chart appended a bogus intraday bar and then, once the real
      // 15m bar rolled, threw "Cannot update oldest data" — inside the engine's
      // listener loop, which froze every other subscriber below it.
      const bars = engine.getCandles(symbol, tf);
      const last = bars[bars.length - 1];
      if (!last || last.time < lastBarTimeRef.current) return;
      // A new bar means the previous one just closed — the only moment a new
      // reversal can print, so markers are rescanned then and not every tick.
      if (last.time > lastBarTimeRef.current) {
        const marks = reversalMarkers(bars);
        markersRef.current?.setMarkers(marks);
        setReversals(marks.length);
      }
      lastBarTimeRef.current = last.time;
      candleRef.current?.update({
        time: last.time, open: last.open, high: last.high, low: last.low, close: last.close,
      });
      volRef.current?.update({
        time: last.time, value: last.volume, color: last.close >= last.open ? UP : DOWN,
      });
      if (emaLastRef.current != null) {
        const k = 2 / 21;
        emaLastRef.current = last.close * k + emaLastRef.current * (1 - k);
        emaRef.current?.update({ time: last.time, value: emaLastRef.current });
      }
    });
    return unsub;
  }, [symbol, tf]);

  // active trade-signal levels: entry / SL / TP as dashed price lines with
  // axis labels, removed as soon as the signal closes or the pair switches
  useEffect(() => {
    const cs = candleRef.current;
    if (!cs) return undefined;
    const lines = [];
    if (signal && signal.symbol === symbol) {
      const mk = (price, color, title) => cs.createPriceLine({
        price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title,
      });
      lines.push(mk(signal.entry, 'rgba(34, 211, 238, 0.85)', 'ENTRY'));
      lines.push(mk(signal.sl, 'rgba(251, 75, 106, 0.9)', 'SL'));
      lines.push(mk(signal.tp, 'rgba(45, 212, 167, 0.9)', 'TP'));
    }
    // React runs cleanups in declaration order, so the chart effect above can
    // destroy the chart before this one runs: removing a price line from a
    // destroyed series throws exactly like the screenshot call does.
    return () => lines.forEach((l) => {
      try { cs.removePriceLine(l); } catch { /* chart already torn down */ }
    });
  }, [signal, symbol]);

  return (
    <section className="panel chart-panel rise" style={{ animationDelay: '120ms' }}>
      <div className="chart-head">
        <div className="chart-title">
          <Badges base={pair.base} quote={pair.quote} size={30} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--disp)', fontWeight: 700, fontSize: 17 }}>{pair.symbol}</span>
              <span className="pair-card-group" style={{ fontSize: 10 }}>{pair.group} · OTC Spot</span>
            </div>
            <div className="price-sub">
              <span className={`num price-hero ${pair.dir > 0 ? 'up' : pair.dir < 0 ? 'down' : ''}`}>
                {fmt(pair.mid, pair.decimals)}
              </span>
              <Delta value={pair.changePct} />
            </div>
          </div>
        </div>
        <div className="tf-tabs">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              className={`tf-tab${t === tf ? ' active' : ''}`}
              onClick={() => onTfChange(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <BarCountdown symbol={symbol} tf={tf} onTfChange={onTfChange} />

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="k">Bid / Ask</div>
          <div className="v cyan">{fmt(pair.bid, pair.decimals)} / {fmt(pair.ask, pair.decimals)}</div>
        </div>
        <div className="stat-tile">
          <div className="k">Spread</div>
          <div className="v">{fmt(pair.spread, 1)} pips</div>
        </div>
        <div className="stat-tile">
          <div className="k">24h High</div>
          <div className="v" style={{ color: 'var(--green)' }}>{fmt(pair.dayHigh, pair.decimals)}</div>
        </div>
        <div className="stat-tile">
          <div className="k">24h Low</div>
          <div className="v" style={{ color: 'var(--red)' }}>{fmt(pair.dayLow, pair.decimals)}</div>
        </div>
        <div className="stat-tile">
          <div className="k">RSI · 14</div>
          <div className={`v violet ${pair.rsi > 55 ? 'num up' : pair.rsi < 45 ? 'num down' : ''}`}>
            {fmt(pair.rsi, 1)}
          </div>
        </div>
      </div>

      <div className="chart-wrap" ref={containerRef}>
        <div style={{
          position: 'absolute', top: 10, left: 14, zIndex: 3, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: 6, color: 'var(--faint)', fontSize: 10,
          letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          <Activity size={11} />
          {symbol} · {tf} · Volatility {fmt(volatilityPips(pair), 1)} pips
          {' · '}{reversals ? `${reversals} reversal${reversals === 1 ? '' : 's'} marked (SWP sweep · RSI exhaustion)` : 'no reversals in view'}
        </div>
        {signal && (
          <div className="chart-sig" style={{ position: 'absolute', top: 28, left: 14, zIndex: 3, pointerEvents: 'none' }}>
            <span className={`chart-sig-side ${signal.side === 'LONG' ? 'up' : 'dn'}`}>{signal.side}</span>
            <span>active signal</span>
            <b>E {fmt(signal.entry, signal.decimals)}</b>
            <b className="up">TP {fmt(signal.tp, signal.decimals)}</b>
            <b className="dn">SL {fmt(signal.sl, signal.decimals)}</b>
          </div>
        )}
      </div>
    </section>
  );
}
