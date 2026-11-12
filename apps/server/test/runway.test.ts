import { describe, expect, it } from 'vitest';
import { addSample, freeNear, runway } from '../src/runway.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const UNTIL = Date.parse('2026-11-25T23:59:59Z');

describe('contract storage runway', () => {
  it('free NEAR is the balance minus 1e19 yocto per stored byte', () => {
    // the live numbers from the outage: 7.1343 NEAR, 713,399 bytes
    expect(freeNear('7134269998249155100000005', 713_399)).toBeCloseTo(0, 3);
    expect(freeNear('10134269998249155100000005', 713_399)).toBeCloseTo(3, 3);
  });

  it('no rate until an hour of samples; out of NEAR is a warning at once', () => {
    const r = runway(0.0003, 713_399, [], NOW, UNTIL, 'c.testnet');
    expect(r.bytesPerDay).toBeNull();
    expect(r.warning).toMatch(/LackBalanceForState/);
  });

  it('warns with the run-out date and the top-up when it runs out before judging ends', () => {
    const samples = [{ at: NOW - DAY, bytes: 600_000 }];
    const r = runway(3, 700_000, samples, NOW, UNTIL, 'c.testnet'); // 100 KB/day = 1 NEAR/day
    expect(r.bytesPerDay).toBe(100_000);
    expect(r.runsOut).toBe('2026-11-15');
    expect(r.topUp).toBeCloseTo(10.5, 1);
    expect(r.warning).toMatch(/2026-11-15.*send 10.5 NEAR/);
  });

  it('no warning when it lasts', () => {
    const r = runway(3, 701_000, [{ at: NOW - DAY, bytes: 700_000 }], NOW, UNTIL, 'c.testnet');
    expect(r.warning).toBeNull();
    expect(r.topUp).toBe(0);
  });

  it('samples are spaced 10 minutes apart and kept 3 days', () => {
    let s = addSample([], { at: NOW - 4 * DAY, bytes: 1 });
    s = addSample(s, { at: NOW, bytes: 2 });
    expect(s).toEqual([{ at: NOW, bytes: 2 }]);
    s = addSample(s, { at: NOW + 60_000, bytes: 3 });
    expect(s).toHaveLength(1);
  });
});
