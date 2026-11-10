// Reference human vs three AI chefs, many seeded shifts:
//   pnpm balance [shifts] [levels…]   levels: easy normal hard (rules v2) or v1 (the pre-v2 bots: hard, normal, normal)
import type { BotSkill } from './bot.ts';
import { balanceSetup, humanShift, summarize } from './balance.ts';

const shifts = Number(process.argv[2] ?? 200);
const levels = process.argv.slice(3).length ? process.argv.slice(3) : ['v1', 'easy', 'normal', 'hard'];
const pct = (x: number): string => `${(100 * x).toFixed(0)}%`.padStart(4);
console.log(`reference human vs 3 AI chefs, ${shifts} seeded shifts each\n`);
console.log('level    human wins  avg place  gap to best bot  human score  bot score  human dishes  bot dishes  hits on human  human burns');
for (const level of levels) {
  const s = summarize(Array.from({ length: shifts }, (_, n) => humanShift(balanceSetup(level as BotSkill | 'v1', n))));
  console.log(`${level.padEnd(8)} ${pct(s.winRate).padStart(10)}  ${s.avgRank.toFixed(2).padStart(9)}  ${s.avgGap.toFixed(0).padStart(15)}  ${s.humanScore.toFixed(0).padStart(11)}  ${s.botScore.toFixed(0).padStart(9)}  ${s.humanDishes.toFixed(1).padStart(12)}  ${s.botDishes.toFixed(1).padStart(10)}  ${s.hitsOnHuman.toFixed(1).padStart(13)}  ${s.humanBurns.toFixed(1).padStart(11)}`);
}
