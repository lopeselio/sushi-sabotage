import { BURNS, BURNT, CARD_INFO, COOKS, TICK_HZ, secs, type Card } from './content.ts';
import { COUNTERS, POD_H, POD_W, counterAt, isHeat, type Counter } from './layout.ts';
import { next, seedFrom, type Rng } from './rng.ts';
import { plan, route, type Goal } from './bot.ts';
import { canCast, type Input, type State } from './sim.ts';

// A "reference human" for balance runs: a deliberately average player, not a bot seat.
// It plays through the same inputs a browser sends (it is never a sim bot), so it measures what a
// person at a keyboard can do against the AI chefs. It knows what to cook (it borrows the bots'
// planner, like the tutorial hints do) but it is slow and sloppy:
//  - ~300 ms between actions (6 ticks, jittered), and a couple of seconds to read the first order;
//  - mashes F about 5 times a second;
//  - sometimes walks a longer route (a detour via a random spot on the floor);
//  - sometimes forgets what's on the pan or in the cooker until it burns;
//  - plays a sabotage card only now and then, and a shield now and then after being hit.
// Deterministic (its own seeded RNG), so balance numbers are reproducible. Not used in matches.

export interface RefHumanOpts {
  reaction: number; // ticks between actions
  jitter: number; // + 0..jitter ticks
  chopEvery: number; // ticks between chops
  detour: number; // chance a new trip takes a detour
  forget: number; // chance a loaded pan/cooker is forgotten until it burns
  cardsPerMin: number; // how often it plays a card when it can
  startDelay: number; // ticks before the first move
}

export const REF_HUMAN: RefHumanOpts = { reaction: 6, jitter: 3, chopEvery: 4, detour: 0.2, forget: 0.15, cardsPerMin: 2, startDelay: secs(2) };

export interface RefHuman {
  o: RefHumanOpts;
  rng: Rng;
  wait: number;
  last: number; // counter of the current trip
  via: { x: number; z: number } | null;
  forgot: Set<number>;
  loaded: boolean[];
}

export const newRefHuman = (seed: string, o: RefHumanOpts = REF_HUMAN): RefHuman =>
  ({ o, rng: { s: seedFrom(`human:${seed}`) }, wait: o.startDelay, last: -1, via: null, forgot: new Set(), loaded: COUNTERS.map(() => false) });

const FLOOR: { x: number; z: number }[] = [];
for (let z = 0; z < POD_H; z++) for (let x = 0; x < POD_W; x++) if (counterAt(x, z) === -1) FLOOR.push({ x, z });

const sign = (d: number, dead: number): -1 | 0 | 1 => (d > dead ? 1 : d < -dead ? -1 : 0);

function humanCard(s: State, i: number, h: RefHuman): Input {
  const c = s.chefs[i];
  if (s.tick < secs(10) || s.chefs.length < 2) return {};
  if (next(h.rng) > h.o.cardsPerMin / (60 * TICK_HZ)) return {};
  const hit = s.sab.some((x) => x.target === i && s.tick - x.tick < secs(15));
  if (hit && !c.shield && next(h.rng) < 0.3 && canCast(s, i, 'bamboo_shield', i)) return { card: 'bamboo_shield', target: i };
  // usually the leader, sometimes whoever
  let target = -1;
  s.chefs.forEach((r, k) => { if (k !== i && (target < 0 || r.score > s.chefs[target].score)) target = k; });
  if (next(h.rng) < 0.4) { const others = s.chefs.map((_, k) => k).filter((k) => k !== i); target = others[Math.floor(next(h.rng) * others.length)]; }
  const cards = (['wasabi_bomb', 'fish_swap', 'dull_knife', 'soy_slick', 'order_shuffle'] as Card[]).filter((k) => canCast(s, i, k, target));
  if (!cards.length) return {};
  const card = cards[Math.floor(next(h.rng) * cards.length)];
  return CARD_INFO[card].self ? {} : { card, target };
}

/** One tick of the reference human's input for chef i. */
export function refHumanInput(s: State, i: number, h: RefHuman): Input {
  const c = s.chefs[i];
  const card = humanCard(s, i, h);

  // notice newly loaded pans/cookers; maybe forget them
  for (const counter of COUNTERS) {
    if (!isHeat(counter.type) || counter.type === 'pot') continue;
    const it = c.st[counter.idx].item;
    if (it && !h.loaded[counter.idx] && COOKS[counter.type][it.k]?.burnsTo && next(h.rng) < h.o.forget) h.forgot.add(counter.idx);
    if (!it || BURNT.has(it.k)) h.forgot.delete(counter.idx);
    h.loaded[counter.idx] = !!it;
  }

  if (h.wait > 0) { h.wait--; return { mx: 0, mz: 0, ...card }; }

  // plan with the forgotten stations out of mind
  const seen = h.forgot.size
    ? { ...s, chefs: s.chefs.map((x, k) => (k !== i ? x : { ...x, st: x.st.map((st, idx) => (h.forgot.has(idx) && st.item && (BURNS[st.item.k] || COOKS.pan[st.item.k] || COOKS.cooker[st.item.k]) ? { item: null, p: 0 } : st)) })) }
    : s;
  const goal: Goal | null = plan(seen, i);
  if (!goal) return { mx: 0, mz: 0, ...card };
  if (goal.counter !== h.last) {
    h.last = goal.counter;
    h.via = next(h.rng) < h.o.detour ? FLOOR[Math.floor(next(h.rng) * FLOOR.length)] : null;
  }
  const cx = Math.floor(c.x), cz = Math.floor(c.z);
  if (h.via && h.via.x === cx && h.via.z === cz) h.via = null;
  const dest: Counter = h.via ? { idx: -1, x: h.via.x, z: h.via.z, type: 'clear' } : COUNTERS[goal.counter];
  const r = h.via
    ? (Math.abs(h.via.x - cx) + Math.abs(h.via.z - cz) <= 1 ? { tx: h.via.x, tz: h.via.z, nx: h.via.x, nz: h.via.z } : route(cx, cz, dest))
    : route(cx, cz, dest);
  if (!r) { h.via = null; return { mx: 0, mz: 0, ...card }; }
  const ox = r.nx + 0.5 - c.x, oz = r.nz + 0.5 - c.z;
  const atCell = r.tx === cx && r.tz === cz;
  if (h.via) {
    if (atCell && Math.abs(ox) < 0.2 && Math.abs(oz) < 0.2) h.via = null;
    return { mx: sign(ox, 0.1), mz: sign(oz, 0.1), ...card };
  }
  if (!atCell || Math.abs(ox) > 0.12 || Math.abs(oz) > 0.12) return { mx: sign(ox, 0.1), mz: sign(oz, 0.1), ...card };
  const counter = COUNTERS[goal.counter];
  const fx = Math.sign(counter.x - cx) as -1 | 0 | 1;
  const fz = Math.sign(counter.z - cz) as -1 | 0 | 1;
  h.wait = goal.action === 'chop' ? h.o.chopEvery : h.o.reaction + Math.floor(next(h.rng) * (h.o.jitter + 1));
  return goal.action === 'chop' ? { mx: fx, mz: fz, chop: true, ...card } : { mx: fx, mz: fz, act: true, ...card };
}
