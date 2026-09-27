import { ListChecks } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { Badges, Delta, Sparkline, signalClass } from './shared';

export default function Watchlist({ pairs, selected, onSelect }) {
  return (
    <section className="panel watchlist-panel rise" style={{ animationDelay: '340ms' }}>
      <div className="watchlist-head">
        <div className="panel-title" style={{ marginBottom: 0 }}>
          <ListChecks size={14} />
          Watchlist
        </div>
        <span className="tag" style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--faint)', letterSpacing: '0.1em' }}>
          {pairs.length} INSTRUMENTS · STREAMING
        </span>
      </div>
      <div className="table-scroll">
        <table className="watch">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Bid</th>
              <th>Ask</th>
              <th>24h Δ</th>
              <th>24h High</th>
              <th>24h Low</th>
              <th>Spread</th>
              <th>RSI-14</th>
              <th>Signal</th>
              <th>Trend</th>
              <th style={{ textAlign: 'left', paddingLeft: 14 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => {
              const closes = engine.getCandles(p.symbol, '15m').slice(-44).map((c) => c.close);
              return (
                <tr
                  key={p.symbol}
                  className={p.symbol === selected ? 'selected' : ''}
                  onClick={() => onSelect(p.symbol)}
                >
                  <td className="pair-cell">
                    <span className="pair-cell-inner">
                      <Badges base={p.base} quote={p.quote} size={24} />
                      <span>
                        {p.symbol}
                        <span className="sub">{p.group}</span>
                      </span>
                    </span>
                  </td>
                  <td className={`num ${p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : ''}`}>
                    {fmt(p.bid, p.decimals)}
                  </td>
                  <td className={`num ${p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : ''}`}>
                    {fmt(p.ask, p.decimals)}
                  </td>
                  <td><Delta value={p.changePct} /></td>
                  <td className="num" style={{ color: 'var(--green)' }}>{fmt(p.dayHigh, p.decimals)}</td>
                  <td className="num" style={{ color: 'var(--red)' }}>{fmt(p.dayLow, p.decimals)}</td>
                  <td className="num" style={{ color: 'var(--muted)' }}>{fmt(p.spread, 1)}p</td>
                  <td className="num" style={{
                    color: p.rsi > 55 ? 'var(--green)' : p.rsi < 45 ? 'var(--red)' : 'var(--muted)',
                  }}>
                    {fmt(p.rsi, 1)}
                  </td>
                  <td><span className={signalClass(p.signal)}>{p.signal}</span></td>
                  <td style={{ textAlign: 'center' }}>
                    <Sparkline data={closes} width={84} height={24} positive={p.change >= 0} />
                  </td>
                  <td style={{ textAlign: 'left', paddingLeft: 14 }}>
                    <button className="btn-trade" onClick={(e) => { e.stopPropagation(); onSelect(p.symbol); }}>
                      ANALYZE
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
