import { describe, expect, it } from 'vitest';
import { seedStorage } from './setup.js';

seedStorage({ pairs: ['US100'], defaultPair: 'US100', initialBalance: 126 });
const { loadSettings, accountBalance } = await import('../src/data/settings.js');

describe('account balance rule', () => {
  it('is the user anchor plus realized trade P&L, nothing else', () => {
    const s = loadSettings();
    expect(s.initialBalance).toBe(126);
    expect(accountBalance(s, 0)).toBe(126);
    expect(accountBalance(s, 37.5)).toBe(163.5);
    expect(accountBalance(s, -58.5)).toBe(67.5);
  });

  it('ignores a legacy balanceAdjust left in storage', () => {
    const legacy = { ...loadSettings(), balanceAdjust: 25 };
    expect(accountBalance(legacy, 37.5)).toBe(163.5);
  });

  it('coerces junk instead of returning NaN', () => {
    expect(accountBalance({ initialBalance: '1000' }, '250.5')).toBe(1250.5);
    expect(accountBalance({}, undefined)).toBe(0);
    expect(accountBalance({ initialBalance: 'abc' }, 10)).toBe(10);
    expect(accountBalance({ initialBalance: 126.005 }, 0.004)).toBe(126.01);
  });
});
