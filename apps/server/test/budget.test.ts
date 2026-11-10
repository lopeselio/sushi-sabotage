import { describe, expect, it } from 'vitest';
import { DAY_MS, PLAYER_RESERVE, affordableRounds, budgetOf, pickLineup, rankedDue } from '../src/budget.ts';

const FEE = 10;
const noon = 20_000 * DAY_MS + DAY_MS / 2; // some UTC day, 12:00
const policy = (spent: number, day = Math.floor(noon / DAY_MS)) => ({ day, spent_today: spent, day_cap: 150, match_cap: 10 });

describe('budgetOf', () => {
  it('keeps the player reserve out of the league budget', () => {
    const b = budgetOf(policy(0), noon, FEE);
    expect(b).toEqual({ left: 150, forPlayers: PLAYER_RESERVE, forLeague: 90, leagueEntries: 9, extras: 60 });
  });
  it('a new day resets what was spent (the contract does the same)', () => {
    expect(budgetOf(policy(150, Math.floor(noon / DAY_MS) - 1), noon, FEE).left).toBe(150);
  });
  it('once only the reserve is left, the league gets nothing but players still can', () => {
    const b = budgetOf(policy(95), noon, FEE);
    expect(b.forLeague).toBe(0);
    expect(b.forPlayers).toBe(55);
    expect(b.leagueEntries).toBe(0);
  });
  it('extras come only from beyond the reserve and three league entries', () => {
    expect(budgetOf(policy(70), noon, FEE).extras).toBe(0); // 80 left: 60 reserve, 20 league (<3 entries)
    expect(budgetOf(policy(40), noon, FEE).extras).toBe(20); // 110 left: 60 reserve, 50 league, 20 spare
  });
});

describe('the league', () => {
  const day = [0, 0, 0, 0].map(() => budgetOf(policy(0), noon, FEE)); // 9 entries each
  it('seats the chefs with the most budget left', () => {
    const b = [budgetOf(policy(0), noon, FEE), budgetOf(policy(80), noon, FEE), budgetOf(policy(20), noon, FEE), budgetOf(policy(40), noon, FEE)];
    expect(pickLineup(b)).toEqual([0, 2, 3]);
  });
  it('counts the ranked rounds four chefs can afford, three seats at a time', () => {
    expect(affordableRounds(day)).toBe(12); // 36 entries / 3 seats
    expect(affordableRounds([budgetOf(policy(150), noon, FEE), ...day.slice(1)])).toBe(9);
  });
  it('spreads ranked rounds over the rest of the day', () => {
    const rounds = 12; // 12 h left → one every hour
    expect(rankedDue(noon, noon - 30 * 60_000, rounds)).toBe(false);
    expect(rankedDue(noon, noon - 61 * 60_000, rounds)).toBe(true);
    expect(rankedDue(noon, noon - DAY_MS, rounds)).toBe(true); // first round of a new day
    expect(rankedDue(noon, noon - 61 * 60_000, 0)).toBe(false); // nothing affordable
  });
  it('a whole day at 15-minute rounds never spends into the player reserve', () => {
    // simulate: four chefs, 96 rounds, ranked only when due, richest three seated
    const spent = [0, 0, 0, 0];
    let last = 0;
    let ranked = 0;
    const start = 20_000 * DAY_MS;
    for (let r = 0; r < 96; r++) {
      const now = start + r * 15 * 60_000;
      const b = spent.map((s) => budgetOf(policy(s, 20_000), now, FEE));
      if (!rankedDue(now, last, affordableRounds(b))) continue;
      for (const i of pickLineup(b)) spent[i] += FEE;
      last = now;
      ranked++;
    }
    expect(ranked).toBeGreaterThanOrEqual(10);
    for (const s of spent) expect(150 - s).toBeGreaterThanOrEqual(PLAYER_RESERVE);
  });
});
