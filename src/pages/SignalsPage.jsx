import { useEffect, useMemo, useState } from 'react';
import { Zap, Target, ShieldAlert, Gauge, Sparkles, Crosshair } from 'lucide-react';
import { engine, fmt } from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import { Badges, Delta, signalClass } from '../components/shared';

export default function SignalsPage() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [autoSet, setAutoSet] = useState(() => new Set(loadSettings().autoTrade));

  useEffect(() => engine.subscribe(setPairs), []);

  const ranked = useMemo(() => {
    const list = pairs.map((s) => ({ s, d: engine.getDetail(s) }));
    return list.sort((a, b) => Math.abs(b.s.score) - Math.abs(a.s.score));
  }, [pairs]);

  const featured = ranked.filter((r) => r.s.signal !== 'NEUTRAL').slice(0, 3);
  const bullish = pairs.filter((p) => p.score > 0).length;
  const bearish = pairs.filter((p) => p.score < 0).length;
  const avgConf = pairs.length
    ? Math.round(pairs.reduce((a, p) => a + p.confidence, 0) / pairs.length)
    : 0;

  const toggleAuto = (sym) => {
    engine.setAutoTrade(sym, !autoSet.has(sym));
    setAutoSet(new Set(loadSettings().autoTrade));
  };

  return (
    <div className="page">
      <div className="stat-row">
        <div className="stat-card rise">
          <div className="stat-ic cyan"><Zap size={17} /></div>
          <div><div className="v">{bullish} / {bearish}</div><div className="k">Bullish / Bearish</div></div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '40ms' }}>
          <div className="stat-ic violet"><Gauge size={17} /></div>
          <div><div className="v">{avgConf}%</div><div className="k">Avg Confidence</div></div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '80ms' }}>
          <div className="stat-ic green"><Target size={17} /></div>
          <div><div className="v">{featured.length}</div><div className="k">Active Setups</div></div>
        </div>
        <div className="stat-card rise" style={{ animationDelay: '120ms' }}>
          <div className="stat-ic rose"><ShieldAlert size={17} /></div>
          <div><div className="v">{autoSet.size}</div><div className="k">Auto-Trade Arms</div></div>
        </div>
      </div>

      {featured.length > 0 && (
        <>
          <div className="sec-title"><Sparkles size={14} /> Top Conviction Setups</div>
          <div className="featured-grid">
            {featured.map(({ s, d }, i) => (
              <div key={s.symbol} className="panel sig-card rise" style={{ animationDelay: `${i * 60}ms` }}>
                <div className="sig-head">
                  <Badges base={s.base} quote={s.quote} size={28} />
                  <div>
                    <div className="sig-sym">{s.symbol}</div>
                    <div className="sig-grp">{s.group}</div>
                  </div>
                  <span className={`sig ${signalClass(s.signal)}`}>{s.signal}</span>
                </div>
                <div className="sig-price">
                  <span className="num" style={{ fontSize: 18, fontWeight: 700 }}>
                    {fmt(s.mid, s.decimals)}
                  </span>
                  <Delta value={s.changePct} />
                </div>
                <div className="sig-levels">
                  <div><span>Entry</span><b>{fmt(d.entry, s.decimals)}</b></div>
                  <div><span>Stop</span><b className="dn">{fmt(d.sl, s.decimals)}</b></div>
                  <div><span>Target</span><b className="up">{fmt(d.tp, s.decimals)}</b></div>
                  <div><span>R : R</span><b>{d.rr.toFixed(2)}</b></div>
                </div>
                <div className="conf-row">
                  <span>Confidence</span>
                  <div className="conf-bar"><i style={{ width: `${s.confidence}%` }} /></div>
                  <b>{s.confidence}%</b>
                </div>
                <div className="reason-chips">
                  {d.reasons.slice(0, 3).map((r) => <span key={r} className="chip">{r}</span>)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sec-title"><Crosshair size={14} /> All Instrument Signals</div>
      <section className="panel watch rise">
        <table>
          <thead>
            <tr>
              <th>Instrument</th><th>Price</th><th>24h</th><th>Signal</th>
              <th>Conf.</th><th>Entry</th><th>Stop</th><th>Target</th><th>R:R</th><th>Auto-Trade</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ s, d }) => (
              <tr key={s.symbol}>
                <td>
                  <span className="wl-pair">
                    <Badges base={s.base} quote={s.quote} size={22} />
                    <b>{s.symbol}</b>
                  </span>
                </td>
                <td className={`num ${s.dir > 0 ? 'up' : s.dir < 0 ? 'down' : ''}`}>{fmt(s.mid, s.decimals)}</td>
                <td><Delta value={s.changePct} /></td>
                <td><span className={`sig ${signalClass(s.signal)}`}>{s.signal}</span></td>
                <td>
                  <div className="conf-cell">
                    <div className="conf-bar sm"><i style={{ width: `${s.confidence}%` }} /></div>
                    {s.confidence}%
                  </div>
                </td>
                <td className="num">{d.side === 'WAIT' ? '—' : fmt(d.entry, s.decimals)}</td>
                <td className="num dn">{d.side === 'WAIT' ? '—' : fmt(d.sl, s.decimals)}</td>
                <td className="num up">{d.side === 'WAIT' ? '—' : fmt(d.tp, s.decimals)}</td>
                <td className="num">{d.side === 'WAIT' ? '—' : d.rr.toFixed(2)}</td>
                <td>
                  <button
                    className={`switch${autoSet.has(s.symbol) ? ' on' : ''}`}
                    onClick={() => toggleAuto(s.symbol)}
                    title={autoSet.has(s.symbol) ? 'Disarm auto-trade' : 'Arm auto-trade'}
                    aria-label={`Auto-trade ${s.symbol}`}
                  >
                    <i />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
