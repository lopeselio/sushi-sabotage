// Reference human vs AI chefs: `pnpm balance [shifts] [bot skills…]`, e.g. `pnpm balance 200 hard normal normal`.
import { humanShift, summarize } from './balance.ts';
import type { BotSkill } from './bot.ts';
import type { Setup } from './sim.ts';

const shifts = Number(process.argv[2] ?? 100);
const bots = (process.argv.slice(3).length ? process.argv.slice(3) : ['hard', 'normal', 'normal']) as BotSkill[];
const setupFor = (n: number): Setup => ({ seed: `bal-${n}`, chefs: [{ name: 'You' }, ...bots.map((b, k) => ({ name: `${b}-${k + 1}`, bot: b }))] });
const rows = Array.from({ length: shifts }, (_, n) => humanShift(setupFor(n)));
const s = summarize(rows);
const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
console.log(`reference human vs ${bots.join(', ')} — ${shifts} shifts`);
console.log(`  human wins ${pct(s.winRate)}  avg place ${s.avgRank.toFixed(2)}  gap to best bot ${s.avgGap.toFixed(0)}`);
console.log(`  score: human ${s.humanScore.toFixed(0)}, bots ${s.botScore.toFixed(0)}  dishes: human ${s.humanDishes.toFixed(1)}, bots ${s.botDishes.toFixed(1)}`);
console.log(`  sabotages landed on the human ${s.hitsOnHuman.toFixed(1)}/shift  human burns ${s.humanBurns.toFixed(1)}/shift`);
