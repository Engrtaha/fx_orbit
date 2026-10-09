import { useEffect, useMemo, useRef } from 'react';
import {
  createChart, CandlestickSeries, ColorType, CrosshairMode, LineStyle, createSeriesMarkers,
} from 'lightweight-charts';
import { X } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { Badges } from './shared';
import { pickTf, sliceWindow, nearestTime } from '../utils/tradeWindow';

const utc = (ms) => new Date(ms).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function Cell({ k, children }) {
  return (
    <div className="td-cell">
      <div className="k">{k}</div>
      <div className="v">{children}</div>
    </div>
  );
}

export default function TradeDetail({ trade, onClose }) {
  const wrapRef = useRef(null);

  const view = useMemo(() => {
    const s = engine.getState(trade.symbol);
    const closed = trade.status === 'closed';
    const dir = trade.side === 'BUY' ? 1 : -1;
    // Window end: the close time, or the newest candle for open trades — no
    // wall-clock read needed, so the render stays pure.
    const m1 = engine.getCandles(trade.symbol, '1m');
    const endSec = closed
      ? Math.floor(trade.closedAt / 1000)
      : (m1.length ? m1[m1.length - 1].time : Math.floor(trade.openedAt / 1000));
    const tf = pickTf(endSec * 1000 - trade.openedAt);
    const bars = sliceWindow(
      engine.getCandles(trade.symbol, tf),
      Math.floor(trade.openedAt / 1000),
      endSec,
    );
    return { s, dec: s ? s.decimals : 5, closed, dir, endMs: endSec * 1000, tf, bars };
  }, [trade]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || view.bars.length < 2) return undefined;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 300,
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
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.12)' },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.12)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
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

    const cs = chart.addSeries(CandlestickSeries, {
      upColor: '#2dd4a7',
      downColor: '#fb4b6a',
      wickUpColor: '#2dd4a7',
      wickDownColor: '#fb4b6a',
      borderVisible: false,
      priceFormat: { type: 'price', precision: view.dec, minMove: 10 ** -view.dec },
    });
    cs.setData(view.bars.map((c) => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    const lines = [
      [trade.entry, '#22d3ee', LineStyle.Solid, 'Entry'],
      [trade.sl, '#fb4b6a', LineStyle.Dashed, 'SL'],
      [trade.tp, '#2dd4a7', LineStyle.Dashed, 'TP'],
    ];
    if (view.closed) lines.push([trade.exit, '#fbbf24', LineStyle.Dotted, 'Exit']);
    else if (view.s) lines.push([view.s.mid, '#e9effc', LineStyle.Dotted, 'Live']);
    for (const [price, color, style, title] of lines) {
      cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    }

    const entryTime = nearestTime(view.bars, Math.floor(trade.openedAt / 1000));
    const markers = [{
      time: entryTime,
      position: view.dir > 0 ? 'belowBar' : 'aboveBar',
      color: view.dir > 0 ? '#2dd4a7' : '#fb4b6a',
      shape: view.dir > 0 ? 'arrowUp' : 'arrowDown',
      text: trade.side,
    }];
    if (view.closed) {
      markers.push({
        time: nearestTime(view.bars, Math.floor(trade.closedAt / 1000)),
        position: view.dir > 0 ? 'aboveBar' : 'belowBar',
        color: trade.pnl >= 0 ? '#2dd4a7' : '#fb4b6a',
        shape: 'circle',
        text: trade.exitReason,
      });
    }
    createSeriesMarkers(cs, markers);

    chart.timeScale().fitContent();
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      chart.applyOptions({ width: Math.floor(width) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [trade, view]);

  const risk = Math.abs(trade.entry - trade.sl);
  const reward = Math.abs(trade.tp - trade.entry);

  return (
    <div className="td-overlay" onClick={onClose} role="presentation">
      <div className="td-modal panel rise" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Trade ${trade.id} detail`}>
        <div className="td-head">
          <div className="td-title">
            {view.s && <Badges base={view.s.base} quote={view.s.quote} size={26} />}
            <b>{trade.id} · {trade.symbol}</b>
            <span className={`side-badge ${view.dir > 0 ? 'buy' : 'sell'}`}>{trade.side}</span>
            <span className={`status-badge ${view.closed ? (trade.pnl > 0 ? 'win' : 'loss') : 'open'}`}>
              {view.closed ? trade.exitReason.toUpperCase() : 'OPEN'}
            </span>
          </div>
          <button className="td-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="td-chart-wrap">
          {view.bars.length >= 2
            ? <div className="td-chart" ref={wrapRef} />
            : <div className="td-nochart">No chart data available for {trade.symbol}.</div>}
          <div className="td-tf">{trade.symbol} · {view.tf} · around the trade window</div>
        </div>

        <div className="td-grid">
          <Cell k="Entry"><span className="num">{fmt(trade.entry, view.dec)}</span></Cell>
          <Cell k="Exit">{view.closed ? <span className="num">{fmt(trade.exit, view.dec)}</span> : <span className="dim">—</span>}</Cell>
          <Cell k="Stop loss"><span className="num" style={{ color: 'var(--red)' }}>{fmt(trade.sl, view.dec)}</span></Cell>
          <Cell k="Take profit"><span className="num" style={{ color: 'var(--green)' }}>{fmt(trade.tp, view.dec)}</span></Cell>
          <Cell k="Pips">{view.closed ? <span className={`num ${trade.pips >= 0 ? 'up' : 'down'}`}>{trade.pips >= 0 ? '+' : ''}{trade.pips}</span> : <span className="dim">—</span>}</Cell>
          <Cell k="P&L">{view.closed ? <span className={`num ${trade.pnl >= 0 ? 'up' : 'down'}`}>{trade.pnl >= 0 ? '+' : ''}{fmt(trade.pnl, 2)} USD</span> : <span className="dim">—</span>}</Cell>
          <Cell k="Lots"><span className="num">{trade.lots}</span></Cell>
          <Cell k="Planned R:R"><span className="num">{(reward / Math.max(risk, 1e-9)).toFixed(2)}</span></Cell>
          <Cell k="Opened"><span className="num">{utc(trade.openedAt)} UTC</span></Cell>
          <Cell k="Closed">{view.closed ? <span className="num">{utc(trade.closedAt)} UTC</span> : <span className="dim">still open</span>}</Cell>
          <Cell k="Duration"><span className="num">{duration(view.endMs - trade.openedAt)}</span></Cell>
          <Cell k="Source"><span>{trade.source}</span></Cell>
        </div>

        {trade.note && (
          <div className="td-note">
            <div className="k">Desk note</div>
            <div>{trade.note}</div>
          </div>
        )}
      </div>
    </div>
  );
}
