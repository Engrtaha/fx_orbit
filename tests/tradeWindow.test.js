import { describe, expect, it } from 'vitest';
import { pickTf, sliceWindow, nearestTime } from '../src/utils/tradeWindow';

const bars = (n, step = 60) => Array.from({ length: n }, (_, i) => ({
  time: 1_700_000_000 + i * step, open: 1, high: 1, low: 1, close: 1,
}));

describe('pickTf', () => {
  it('scales timeframe with trade age', () => {
    expect(pickTf(3 * 3600e3)).toBe('1m');
    expect(pickTf(20 * 3600e3)).toBe('5m');
    expect(pickTf(60 * 3600e3)).toBe('15m');
    expect(pickTf(200 * 3600e3)).toBe('4H');
  });
});

describe('sliceWindow', () => {
  const cs = bars(300);

  it('keeps bars around the trade window with padding', () => {
    const t0 = cs[100].time;
    const out = sliceWindow(cs, t0, t0 + 60);
    expect(out[0].time).toBe(cs[84].time);
    expect(out.at(-1).time).toBe(cs[117].time);
    expect(out.length).toBe(34);
  });

  it('clamps to available history', () => {
    const out = sliceWindow(cs, cs[299].time, cs[299].time);
    expect(out[0].time).toBe(cs[283].time);
    expect(out.at(-1).time).toBe(cs[299].time);
  });

  it('falls back to the tail when the window is missing', () => {
    const out = sliceWindow(cs, cs[0].time - 10_000_000, cs[0].time - 9_999_000);
    expect(out.length).toBe(40);
    expect(out.at(-1).time).toBe(cs[299].time);
  });

  it('handles empty candles', () => {
    expect(sliceWindow([], 0, 1)).toEqual([]);
  });
});

describe('nearestTime', () => {
  it('snaps to the closest bar', () => {
    const cs2 = bars(5);
    expect(nearestTime(cs2, cs2[2].time + 20)).toBe(cs2[2].time);
    expect(nearestTime(cs2, cs2[2].time + 40)).toBe(cs2[3].time);
  });
});
