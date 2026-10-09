import { useEffect, useRef } from 'react';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode,
} from 'lightweight-charts';
import { Activity } from 'lucide-react';
import { TIMEFRAMES, engine, fmt, volatilityPips } from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import { fetchTvHistory } from '../data/tvClient';
import { chartCapture } from '../data/chartCapture';
import { Badges, Delta } from './shared';

const UP = 'rgba(45, 212, 167, 0.32)';
const DOWN = 'rgba(251, 75, 106, 0.32)';

function emaSeries(candles, period) {
  const k = 2 / (period + 1);
  let prev;
  return candles.map((c, i) => {
    prev = i === 0 ? c.close : c.close * k + prev * (1 - k);
    return { time: c.time, value: prev };
  });
}

export default function PriceChart({ pair, symbol, tf, onTfChange, signal }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volRef = useRef(null);
  const emaRef = useRef(null);
  const emaLastRef = useRef(null);

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
    const settings = loadSettings();
    const backfill = settings.tvEnabled
      ? fetchTvHistory(settings.tvBackendUrl, symbol, tf).catch(() => 0)
      : Promise.resolve(0);

    backfill.then(() => {
      if (cancelled) return;
      const data = engine.getCandles(symbol, tf);
      const dec = engine.getState(symbol).decimals;
      const minMove = 10 ** -dec;

      cs.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove } });
      cs.setData(data.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      volRef.current.setData(
        data.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? UP : DOWN }))
      );
      const ema = emaSeries(data, 20);
      emaLastRef.current = ema.length ? ema[ema.length - 1].value : null;
      emaRef.current.setData(ema);
      chartRef.current.timeScale().fitContent();
    });
    return () => { cancelled = true; };
  }, [symbol, tf]);

  // stream live ticks into the active chart
  useEffect(() => {
    const unsub = engine.subscribe(() => {
      const s = engine.getState(symbol);
      if (!s) return;
      const last = s.liveCandle;
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
  }, [symbol]);

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
    return () => lines.forEach((l) => cs.removePriceLine(l));
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
