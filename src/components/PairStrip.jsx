import { engine, fmt } from '../data/marketEngine';
import { Badges, Delta, Sparkline } from './shared';

export default function PairStrip({ pairs, selected, onSelect }) {
  return (
    <section className="pair-strip">
      {pairs.map((p, i) => {
        const sparkCandles = engine.getCandles(p.symbol, '15m').slice(-44);
        const closes = sparkCandles.map((c) => c.close);
        return (
          <div
            key={p.symbol}
            className={`pair-card panel rise ${p.symbol === selected ? 'active' : ''}`}
            style={{ animationDelay: `${i * 55}ms` }}
            onClick={() => onSelect(p.symbol)}
          >
            <div className="pair-card-top">
              <Badges base={p.base} quote={p.quote} />
              <span className="pair-card-sym">{p.symbol}</span>
              <span className="pair-card-group">{p.group}</span>
            </div>
            <div className="pair-card-mid">
              <div>
                <div className={`num pair-card-price ${p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : ''}`}>
                  {fmt(p.mid, p.decimals)}
                </div>
                <div style={{ marginTop: 5 }}>
                  <Delta value={p.changePct} />
                </div>
              </div>
              <Sparkline data={closes} positive={p.change >= 0} />
            </div>
          </div>
        );
      })}
    </section>
  );
}
