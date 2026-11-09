// Headless balance run: AI chefs only. `pnpm sim [shifts] [skill...]`
import { RECIPES, SHIFT_TICKS } from './content.ts';
import { botAccuse, createState, results, stateHash, step, type Accusation, type BotSkill } from './index.ts';

const shifts = Number(process.argv[2] ?? 5);
const skills = (process.argv.slice(3).length ? process.argv.slice(3) : ['hard', 'normal', 'normal', 'easy']) as BotSkill[];
const totals = skills.map(() => ({ score: 0, delivered: 0, burns: 0, expired: 0, wrong: 0, hits: 0, wins: 0 }));
for (let n = 0; n < shifts; n++) {
  const s = createState({ seed: `balance-${n}`, chefs: skills.map((b, i) => ({ name: `${b}-${i}`, bot: b })) });
  while (!s.over) step(s);
  const acc: Accusation[] = [];
  s.sab.forEach((x, k) => { const a = botAccuse(s, x.target, k); if (a !== null) acc.push({ victim: x.target, sab: k, accused: a }); });
  const res = results(s, acc);
  res.forEach((r, i) => {
    const c = s.chefs[i];
    const t = totals[i];
    t.score += r.final; t.delivered += c.delivered; t.burns += c.burns; t.expired += c.expired; t.wrong += c.wrong; t.hits += c.hits;
    if (r.rank === 1) t.wins++;
  });
  console.log(`shift ${n}: ${res.map((r) => `${r.name}=${r.final}`).join('  ')}  sabotages=${s.sab.length}  hash=${stateHash(s).slice(0, 12)}`);
}
console.log(`\n${shifts} shifts of ${SHIFT_TICKS / 20}s, ${RECIPES.length} recipes. Averages:`);
totals.forEach((t, i) => console.log(`  ${skills[i].padEnd(6)} score ${(t.score / shifts).toFixed(0).padStart(5)}  delivered ${(t.delivered / shifts).toFixed(1)}  burns ${(t.burns / shifts).toFixed(1)}  expired ${(t.expired / shifts).toFixed(1)}  wrong ${(t.wrong / shifts).toFixed(1)}  hits ${(t.hits / shifts).toFixed(1)}  wins ${t.wins}`));
