import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CandlestickChart } from 'lucide-react';
import { engine } from '../data/marketEngine';
import { loadSettings } from '../data/settings';
import PriceChart from '../components/PriceChart';

export default function ChartsPage() {
  const [pairs, setPairs] = useState(() => engine.getSnapshot());
  const [symbol, setSymbol] = useState(() => {
    const snap = engine.getSnapshot();
    const { defaultPair } = loadSettings();
    return snap.some((s) => s.symbol === defaultPair) ? defaultPair : snap[0]?.symbol ?? 'EUR/USD';
  });
  const [tf, setTf] = useState('15m');
  const location = useLocation();
  const [prevNavState, setPrevNavState] = useState(null);

  // search-box navigation lands here with a target symbol in router state
  if (location.state !== prevNavState) {
    setPrevNavState(location.state);
    const s = location.state?.symbol;
    if (s && engine.getState(s)) setSymbol(s);
  }

  useEffect(() => engine.subscribe(setPairs), []);

  const pair = useMemo(() => pairs.find((p) => p.symbol === symbol) ?? pairs[0], [pairs, symbol]);

  if (!pair) return null;

  return (
    <div className="page charts-page">
      <p className="strat-lead">
        <CandlestickChart size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
        Real-time charts for every instrument enabled in your universe
      </p>

      <div className="pair-chips rise">
        {pairs.map((p) => (
          <button
            key={p.symbol}
            className={`pair-chip${p.symbol === pair.symbol ? ' on' : ''}`}
            onClick={() => setSymbol(p.symbol)}
          >
            {p.symbol}
          </button>
        ))}
      </div>

      <PriceChart pair={pair} symbol={pair.symbol} tf={tf} onTfChange={setTf} />
    </div>
  );
}
