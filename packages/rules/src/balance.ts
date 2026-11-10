import { botAccuse, createState, results, step, type Accusation, type Input, type Setup } from './sim.ts';
import { newRefHuman, refHumanInput, type RefHumanOpts } from './refhuman.ts';

// Reference human (seat 0) vs AI chefs, many seeded shifts. Used by `pnpm balance` and the tests.

export interface BalanceRow { rank: number; won: boolean; gap: number; score: number; botScore: number; dishes: number; botDishes: number; hitsOnHuman: number; burns: number }
export interface BalanceSummary { shifts: number; winRate: number; avgRank: number; avgGap: number; humanScore: number; botScore: number; humanDishes: number; botDishes: number; hitsOnHuman: number; humanBurns: number }

/** One shift: `setup.chefs[0]` must be a human seat; the reference human plays it. */
export function humanShift(setup: Setup, opts?: RefHumanOpts): BalanceRow {
  const s = createState(setup);
  const h = newRefHuman(setup.seed, opts);
  while (!s.over) {
    const inputs: (Input | undefined)[] = [refHumanInput(s, 0, h)];
    step(s, inputs);
  }
  // everyone, the human included, guesses like the bots do (a 25% pass, weighted by deliveries)
  const acc: Accusation[] = [];
  s.sab.forEach((x, k) => { if (x.card === 'bamboo_shield') return; const a = botAccuse(s, x.target, k); if (a !== null) acc.push({ victim: x.target, sab: k, accused: a }); });
  const res = results(s, acc);
  const best = Math.max(...res.slice(1).map((r) => r.final));
  const bots = s.chefs.slice(1);
  return {
    rank: res[0].rank,
    won: res[0].rank === 1,
    gap: res[0].final - best,
    score: res[0].final,
    botScore: res.slice(1).reduce((a, r) => a + r.final, 0) / Math.max(1, res.length - 1),
    dishes: s.chefs[0].delivered,
    botDishes: bots.reduce((a, c) => a + c.delivered, 0) / Math.max(1, bots.length),
    hitsOnHuman: s.sab.filter((x) => x.target === 0 && x.caster !== 0 && !x.blocked && !x.fizzled).length,
    burns: s.chefs[0].burns,
  };
}

export function summarize(rows: BalanceRow[]): BalanceSummary {
  const n = rows.length || 1;
  const avg = (f: (r: BalanceRow) => number): number => rows.reduce((a, r) => a + f(r), 0) / n;
  return {
    shifts: rows.length,
    winRate: avg((r) => (r.won ? 1 : 0)),
    avgRank: avg((r) => r.rank),
    avgGap: avg((r) => r.gap),
    humanScore: avg((r) => r.score),
    botScore: avg((r) => r.botScore),
    humanDishes: avg((r) => r.dishes),
    botDishes: avg((r) => r.botDishes),
    hitsOnHuman: avg((r) => r.hitsOnHuman),
    humanBurns: avg((r) => r.burns),
  };
}
