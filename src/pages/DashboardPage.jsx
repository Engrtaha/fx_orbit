import { useEffect, useState } from 'react';
import PairStrip from '../components/PairStrip';
import PriceChart from '../components/PriceChart';
import ScannerPanel from '../components/ScannerPanel';
import Watchlist from '../components/Watchlist';

export default function DashboardPage({ pairs, symbol, setSymbol, pending, setPending }) {
  const [tf, setTf] = useState('15m');

  useEffect(() => {
    if (pending && pairs.some((p) => p.symbol === pending)) {
      setSymbol(pending);
      setPending(null);
    }
  }, [pending, pairs, setSymbol, setPending]);

  const selected = pairs.find((p) => p.symbol === symbol) ?? pairs[0];

  return (
    <>
      <PairStrip pairs={pairs} selected={selected?.symbol} onSelect={setSymbol} />
      <div className="workspace">
        {selected && <PriceChart pair={selected} symbol={selected.symbol} tf={tf} onTfChange={setTf} />}
        <ScannerPanel pairs={pairs} onSelect={setSymbol} />
      </div>
      <Watchlist pairs={pairs} selected={selected?.symbol} onSelect={setSymbol} />
    </>
  );
}
