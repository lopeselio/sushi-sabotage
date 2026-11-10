import { BURNS, BURNT, CARD_INFO, COOKS, TICK_HZ, secs, type Card, type ItemKind } from './content.ts';
import { COUNTERS, POD_H, POD_W, counterAt, isHeat, type Counter } from './layout.ts';
import { next, seedFrom, type Rng } from './rng.ts';
import { plan, route, type BotSkill, type BotState, type Goal } from './bot.ts';
import { canCast, type Input, type State } from './sim.ts';

// AI chefs, rules v2: the same planner as v1 (it always knows what to cook next), driven with a
// difficulty profile that makes it slower and sloppier the way a person is. Deterministic: every
// roll comes from the bot's own seeded RNG, which lives in the sim state.
// v1 bots (bot.ts) stay exactly as they were so matches settled under v1 still replay.

export interface Profile {
  reaction: number; // ticks of thinking after each action
  jitter: number; // + 0..jitter ticks
  chopEvery: number; // ticks between chops
  startDelay: number; // ticks before the first move
  stride: number; // share of walking ticks it actually moves (1 = full speed)
  detour: number; // chance a trip goes via a random spot on the floor
  forget: number; // chance a loaded pan/cooker is forgotten until it burns
  fumble: number; // chance a trip to a crate grabs the wrong ingredient
  dazed: number; // ticks it stands confused after a sabotage lands on it
  cardsPerMin: number; // how often it plays a card when it can
  firstCard: number; // no sabotage before this tick
  focus: number; // chance it aims at the leader rather than any rival (1 = everyone gangs up on the leader)
  shield: number; // chance it raises a shield (when it can) after being hit
}

export const PROFILES: Record<BotSkill, Profile> = {
  easy: { reaction: 9, jitter: 6, chopEvery: 6, startDelay: secs(3), stride: 0.85, detour: 0.3, forget: 0.2, fumble: 0.1, dazed: secs(2), cardsPerMin: 1, firstCard: secs(60), focus: 0.3, shield: 0.1 },
  normal: { reaction: 8, jitter: 5, chopEvery: 5, startDelay: secs(2), stride: 0.95, detour: 0.15, forget: 0.14, fumble: 0.05, dazed: secs(1), cardsPerMin: 2, firstCard: secs(30), focus: 0.6, shield: 0.2 },
  hard: { reaction: 6, jitter: 4, chopEvery: 5, startDelay: secs(1), stride: 1, detour: 0.12, forget: 0.12, fumble: 0.02, dazed: secs(0.5), cardsPerMin: 4, firstCard: secs(15), focus: 1, shield: 0.3 },
};

/** What the driver remembers between ticks. Plain numbers only, so it hashes with the state. */
export interface Mind {
  wait: number;
  last: number; // counter of the current trip
  vx: number; vz: number; // detour waypoint, -1 = none
  forgot: number[]; // heat counters it isn't watching
  loaded: number[]; // heat counters that held something last tick
  seen: number; // sabotages already noticed
  shield: number; // 1 = wants to raise a shield
}

export const newMind = (p: Profile): Mind => ({ wait: p.startDelay, last: -1, vx: -1, vz: -1, forgot: [], loaded: [], seen: 0, shield: 0 });

export interface BotV2 extends BotState { v: 2; mind: Mind }

export const newBotV2 = (skill: BotSkill, seed: string, rival = -1): BotV2 =>
  ({ v: 2, skill, rng: { s: seedFrom(`bot2:${seed}`) }, wait: 0, rival, mind: newMind(PROFILES[skill]) });

const FLOOR: { x: number; z: number }[] = [];
for (let z = 0; z < POD_H; z++) for (let x = 0; x < POD_W; x++) if (counterAt(x, z) === -1) FLOOR.push({ x, z });
const CRATES = COUNTERS.filter((c) => c.type === 'container');
const sign = (d: number, dead: number): -1 | 0 | 1 => (d > dead ? 1 : d < -dead ? -1 : 0);
const watchable = (k: ItemKind): boolean => !!(BURNS[k] || COOKS.pan[k]?.burnsTo || COOKS.cooker[k]?.burnsTo);

/** A sabotage card for chef i under profile p, or nothing this tick. */
export function sloppyCard(s: State, i: number, m: Mind, p: Profile, rng: Rng): Input {
  const c = s.chefs[i];
  if (s.chefs.length < 2 || s.tick < c.cdUntil) return {};
  if (m.shield) {
    m.shield = 0;
    if (!c.shield && canCast(s, i, 'bamboo_shield', i)) return { card: 'bamboo_shield', target: i };
  }
  if (s.tick < p.firstCard) return {};
  if (next(rng) > p.cardsPerMin / (60 * TICK_HZ)) return {};
  let target = -1;
  s.chefs.forEach((r, k) => { if (k !== i && (target < 0 || r.score > s.chefs[target].score)) target = k; });
  if (next(rng) >= p.focus) { const others = s.chefs.map((_, k) => k).filter((k) => k !== i); target = others[Math.floor(next(rng) * others.length)]; }
  const cards = (['wasabi_bomb', 'fish_swap', 'dull_knife', 'soy_slick', 'order_shuffle'] as Card[]).filter((k) => canCast(s, i, k, target));
  if (!cards.length) return {};
  const card = cards.find((k) => CARD_INFO[k].cost >= 2 && next(rng) < 0.5) ?? cards[Math.floor(next(rng) * cards.length)];
  return { card, target };
}

/** Drive chef i toward the planner's next step, as sloppily as profile p says. */
export function sloppyMove(s: State, i: number, m: Mind, p: Profile, rng: Rng): Input {
  const c = s.chefs[i];

  // notice newly loaded pans/cookers, maybe stop watching them; burnt or empty ones come back to mind
  for (const counter of COUNTERS) {
    if (counter.type !== 'pan' && counter.type !== 'cooker') continue;
    const it = c.st[counter.idx].item;
    const was = m.loaded.includes(counter.idx);
    if (it && !was && watchable(it.k) && next(rng) < p.forget && !m.forgot.includes(counter.idx)) m.forgot.push(counter.idx);
    if (!it || BURNT.has(it.k)) m.forgot = m.forgot.filter((x) => x !== counter.idx);
    if (it && !was) m.loaded.push(counter.idx);
    if (!it && was) m.loaded = m.loaded.filter((x) => x !== counter.idx);
  }
  // a sabotage that lands leaves it standing there for a moment
  while (m.seen < s.sab.length) {
    const x = s.sab[m.seen++];
    if (x.target !== i || x.caster === i) continue;
    if (!x.blocked && !x.fizzled) m.wait = Math.max(m.wait, p.dazed);
    if (next(rng) < p.shield) m.shield = 1;
  }
  if (m.wait > 0) { m.wait--; return { mx: 0, mz: 0 }; }

  const view = m.forgot.length
    ? { ...s, chefs: s.chefs.map((x, k) => (k !== i ? x : { ...x, st: x.st.map((st, idx) => (m.forgot.includes(idx) && st.item && watchable(st.item.k) ? { item: null, p: 0 } : st)) })) }
    : s;
  const planned = plan(view, i);
  if (!planned) return { mx: 0, mz: 0 };
  let goal: Goal = planned;
  if (!c.held && m.last >= 0 && COUNTERS[m.last].type === 'container' && COUNTERS[planned.counter].type === 'container') {
    goal = { counter: m.last, action: 'act' }; // already on its way to a crate (maybe the wrong one)
  } else if (goal.counter !== m.last) {
    // a fresh trip: maybe the wrong crate, maybe the long way round
    if (!c.held && COUNTERS[goal.counter].type === 'container' && next(rng) < p.fumble) {
      const wrong = CRATES.filter((x) => x.idx !== planned.counter);
      goal = { counter: wrong[Math.floor(next(rng) * wrong.length)].idx, action: 'act' };
    }
    m.last = goal.counter;
    const via = next(rng) < p.detour ? FLOOR[Math.floor(next(rng) * FLOOR.length)] : null;
    m.vx = via ? via.x : -1; m.vz = via ? via.z : -1;
  }
  if (p.stride < 1 && next(rng) > p.stride) return { mx: 0, mz: 0 };

  const cx = Math.floor(c.x), cz = Math.floor(c.z);
  if (m.vx >= 0) {
    if (Math.abs(m.vx - cx) + Math.abs(m.vz - cz) <= 1) { m.vx = -1; m.vz = -1; }
    else {
      const r = route(cx, cz, { idx: -1, x: m.vx, z: m.vz, type: 'clear' } as Counter);
      if (r) return { mx: sign(r.nx + 0.5 - c.x, 0.1), mz: sign(r.nz + 0.5 - c.z, 0.1) };
      m.vx = -1; m.vz = -1;
    }
  }
  const counter = COUNTERS[goal.counter];
  const r = route(cx, cz, counter);
  if (!r) return { mx: 0, mz: 0 };
  const ox = r.nx + 0.5 - c.x, oz = r.nz + 0.5 - c.z;
  if (r.tx !== cx || r.tz !== cz || Math.abs(ox) > 0.12 || Math.abs(oz) > 0.12) return { mx: sign(ox, 0.1), mz: sign(oz, 0.1) };
  const fx = Math.sign(counter.x - cx) as -1 | 0 | 1;
  const fz = Math.sign(counter.z - cz) as -1 | 0 | 1;
  m.wait = goal.action === 'chop' ? p.chopEvery : p.reaction + Math.floor(next(rng) * (p.jitter + 1));
  return goal.action === 'chop' ? { mx: fx, mz: fz, chop: true } : { mx: fx, mz: fz, act: true };
}

export function botInputV2(s: State, i: number): Input {
  const b = s.chefs[i].bot as BotV2;
  const p = PROFILES[b.skill];
  return { ...sloppyMove(s, i, b.mind, p, b.rng), ...sloppyCard(s, i, b.mind, p, b.rng) };
}
