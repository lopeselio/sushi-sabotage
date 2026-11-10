import { BURNS, BURNT, CARD_INFO, COOKS, CUTS, PLATEABLE, RECIPES, secs, type Card, type ItemKind } from './content.ts';
import { COUNTERS, POD_H, POD_W, counterAt, isHeat, type Counter } from './layout.ts';
import { next, seedFrom, type Rng } from './rng.ts';
import { canAddToPlate, canCast, type Chef, type Input, type Item, type State } from './sim.ts';

// AI chefs. Deterministic: they read the sim state and emit the same kind of input a human does.
// The language model never drives a bot; it only voices them.

export type BotSkill = 'easy' | 'normal' | 'hard';

const SKILL: Record<BotSkill, { reaction: number; chopEvery: number; aggression: number }> = {
  easy: { reaction: 9, chopEvery: 7, aggression: 0.008 },
  normal: { reaction: 5, chopEvery: 4, aggression: 0.014 },
  hard: { reaction: 2, chopEvery: 3, aggression: 0.022 },
};

export interface BotState { skill: BotSkill; rng: Rng; wait: number; rival: number }

export const newBot = (skill: BotSkill, seed: string, rival = -1): BotState => ({ skill, rng: { s: seedFrom(`bot:${seed}`) }, wait: 0, rival });

export interface Goal { counter: number; action: 'act' | 'chop' }

const ASM = counterAt(4, 3); // the bot assembles its dish on the middle of the island
const reachable = (c: Counter): boolean => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => counterAt(c.x + dx, c.z + dz) === -1);
// side counters to park things on, nearest the middle of the pod first
const CLEARS = COUNTERS.filter((c) => c.type === 'clear' && c.idx !== ASM && reachable(c))
  .sort((a, b) => Math.abs(a.x - 4) + Math.abs(a.z - 3) - (Math.abs(b.x - 4) + Math.abs(b.z - 3)) || a.idx - b.idx);
const BOARDS = COUNTERS.filter((c) => c.type === 'board');
const HEATS = COUNTERS.filter((c) => isHeat(c.type));
const byType = (t: Counter['type']): Counter => COUNTERS.find((c) => c.type === t)!;
const TRASH = byType('trash').idx;
const DELIVERY = byType('delivery').idx;
const PLATES = byType('plates').idx;
const POT = byType('pot').idx;

const CHAIN: Partial<Record<ItemKind, ItemKind[]>> = {
  sushi_rice: ['rice_raw', 'rice_cooked', 'sushi_rice'],
  nori_roll: ['nori_sheet', 'nori_roll'],
  nori_cone: ['nori_cone'],
  fish_seared: ['fish', 'fish_sliced', 'fish_seared'],
  lobster_seared: ['lobster', 'lobster_sliced', 'lobster_seared'],
  tomato_blistered: ['tomato', 'tomato_sliced', 'tomato_blistered'],
  avocado_diced: ['avocado', 'avocado_diced'],
};
const RAW_OF: Partial<Record<ItemKind, ItemKind>> = {
  sushi_rice: 'rice_raw', nori_roll: 'nori_sheet', nori_cone: 'nori_cone', fish_seared: 'fish', lobster_seared: 'lobster',
  tomato_blistered: 'tomato', avocado_diced: 'avocado', wasabi_sliced: 'wasabi', wasabi_chutney: 'wasabi',
};
// longest chains first, so slow stations start early
const PRIORITY: ItemKind[] = ['wasabi_chutney', 'sushi_rice', 'fish_seared', 'lobster_seared', 'tomato_blistered', 'nori_roll', 'avocado_diced', 'wasabi_sliced', 'nori_cone'];

const sameSet = (a: readonly ItemKind[], b: readonly ItemKind[]): boolean => a.length === b.length && a.every((k) => b.includes(k));
const subset = (a: readonly ItemKind[], b: readonly ItemKind[]): boolean => a.every((k) => b.includes(k));

// ---------- planning ----------

interface View {
  c: Chef;
  plate: Item | null; // plate on the assembly counter
  need: ItemKind[]; // ingredients the target dish still lacks
  needAll: Set<ItemKind>; // anything any waiting order could use
  orderMatch: (on: readonly ItemKind[]) => boolean;
  compatible: (on: readonly ItemKind[]) => boolean;
}

function view(s: State, i: number): View {
  const c = s.chefs[i];
  const asm = c.st[ASM].item;
  const plate = asm?.k === 'plate' ? asm : null;
  const on = plate?.on ?? [];
  const orders = [...c.orders].sort((a, b) => a.due - b.due || a.id - b.id);
  const target = orders.find((o) => subset(on, RECIPES[o.recipe].ingredients));
  const need = target ? RECIPES[target.recipe].ingredients.filter((k) => !on.includes(k)) : [];
  const needAll = new Set<ItemKind>(orders.flatMap((o) => RECIPES[o.recipe].ingredients));
  return {
    c, plate, need, needAll,
    orderMatch: (x) => c.orders.some((o) => sameSet(x, RECIPES[o.recipe].ingredients)),
    compatible: (x) => c.orders.some((o) => subset(x, RECIPES[o.recipe].ingredients)),
  };
}

/** Loose items in the pod (held + on stations, not on plates), with where they sit. */
function loose(c: Chef): { k: ItemKind; at: number }[] {
  const out: { k: ItemKind; at: number }[] = [];
  if (c.held && c.held.k !== 'plate') out.push({ k: c.held.k, at: -1 });
  c.st.forEach((st, idx) => { if (st.item && st.item.k !== 'plate') out.push({ k: st.item.k, at: idx }); });
  return out;
}

function inPipeline(v: View, want: ItemKind): boolean {
  const items = loose(v.c);
  if (want === 'wasabi_sliced' || want === 'wasabi_chutney') {
    const needC = v.need.includes('wasabi_chutney');
    const haveC = items.some((x) => x.k === 'wasabi_chutney' || (x.k === 'wasabi_sliced' && x.at === POT));
    const flight = items.filter((x) => x.k === 'wasabi' || (x.k === 'wasabi_sliced' && x.at !== POT)).length;
    if (want === 'wasabi_chutney') return haveC || flight >= 1;
    return flight - (needC && !haveC ? 1 : 0) >= 1;
  }
  const chain = CHAIN[want] ?? [want];
  return items.some((x) => chain.includes(x.k));
}

const emptyOf = (c: Chef, list: Counter[]): Counter | undefined => list.find((x) => !c.st[x.idx].item);

function park(c: Chef): Goal {
  const spot = emptyOf(c, CLEARS);
  return spot ? { counter: spot.idx, action: 'act' } : { counter: TRASH, action: 'act' };
}

function planHeld(v: View, h: Item): Goal {
  const c = v.c;
  if (h.k === 'plate') {
    const on = h.on ?? [];
    if (on.length && v.orderMatch(on)) return { counter: DELIVERY, action: 'act' };
    if (!c.st[ASM].item && (on.length === 0 || v.compatible(on))) return { counter: ASM, action: 'act' };
    return { counter: TRASH, action: 'act' };
  }
  if (BURNT.has(h.k)) return { counter: TRASH, action: 'act' };

  if (h.k === 'wasabi_sliced' && v.need.includes('wasabi_chutney') && !loose(c).some((x) => x.k === 'wasabi_chutney' || (x.k === 'wasabi_sliced' && x.at === POT))) {
    return c.st[POT].item ? park(c) : { counter: POT, action: 'act' };
  }
  if (h.k === 'nori_cone' && !v.plate && v.need.includes('nori_cone')) return park(c);
  if (PLATEABLE.has(h.k)) {
    if (v.plate && v.need.includes(h.k) && canAddToPlate(v.plate.on!, h.k)) return { counter: ASM, action: 'act' };
    if (v.needAll.has(h.k)) return park(c);
    return { counter: TRASH, action: 'act' };
  }
  if (CUTS[h.k]) {
    const b = emptyOf(c, BOARDS);
    return b ? { counter: b.idx, action: 'act' } : park(c);
  }
  const fits = HEATS.filter((x) => isHeat(x.type) && COOKS[x.type][h.k]);
  if (fits.length) { const free = emptyOf(c, fits); return free ? { counter: free.idx, action: 'act' } : park(c); }
  return { counter: TRASH, action: 'act' };
}

/** Would picking up this parked item make progress (so the bot doesn't shuffle items forever)? */
function worthPicking(v: View, k: ItemKind): boolean {
  const c = v.c;
  if (BURNT.has(k)) return true;
  if (k === 'wasabi_sliced' && v.need.includes('wasabi_chutney') && !c.st[POT].item) return true;
  if (PLATEABLE.has(k)) return !!v.plate && v.need.includes(k) && canAddToPlate(v.plate.on!, k);
  if (CUTS[k]) return !!emptyOf(c, BOARDS);
  return !!emptyOf(c, HEATS.filter((x) => isHeat(x.type) && COOKS[x.type][k]));
}

export function plan(s: State, i: number): Goal | null {
  const v = view(s, i);
  const c = v.c;
  if (c.held) return planHeld(v, c.held);

  // 1. a finished dish on the island goes out
  if (v.plate && v.plate.on!.length && v.orderMatch(v.plate.on!)) return { counter: ASM, action: 'act' };
  // a plate nobody can use gets cleared
  if (v.plate && v.plate.on!.length && !v.compatible(v.plate.on!)) return { counter: ASM, action: 'act' };

  // 2. rescue anything cooked (before it burns) or burnt from the heat stations
  for (const h of HEATS) {
    const it = c.st[h.idx].item;
    if (!it || !isHeat(h.type)) continue;
    if (COOKS[h.type][it.k]) continue; // still cooking
    if (BURNT.has(it.k) || BURNS[it.k] || it.k === 'tomato_blistered' || it.k === 'wasabi_chutney') {
      // non-burning products can wait until there's a plate to put them on
      if (!BURNS[it.k] && !BURNT.has(it.k) && !(v.plate && v.need.includes(it.k))) continue;
      return { counter: h.idx, action: 'act' };
    }
  }
  // 3. chop whatever is on a board, then 4. take the result
  for (const b of BOARDS) { const it = c.st[b.idx].item; if (it && CUTS[it.k]) return { counter: b.idx, action: 'chop' }; }
  for (const b of BOARDS) { const it = c.st[b.idx].item; if (it && !CUTS[it.k] && worthPicking(v, it.k)) return { counter: b.idx, action: 'act' }; }
  // 5. parked items that can move on now
  for (const p of CLEARS) { const it = c.st[p.idx].item; if (it && it.k !== 'plate' && worthPicking(v, it.k)) return { counter: p.idx, action: 'act' }; }
  // a stray plate on a side counter comes back to the island
  if (!c.st[ASM].item) { for (const p of CLEARS) if (c.st[p.idx].item?.k === 'plate') return { counter: p.idx, action: 'act' }; }
  // 6. a plate on the island
  if (!c.st[ASM].item && c.plates > 0 && v.need.length) return { counter: PLATES, action: 'act' };
  if (c.st[ASM].item && !v.plate) return { counter: ASM, action: 'act' }; // something else is in the way
  // 7. fetch the next missing ingredient
  for (const want of PRIORITY) {
    if (!v.need.includes(want) || inPipeline(v, want)) continue;
    const raw = RAW_OF[want]!;
    if (CUTS[raw] && !emptyOf(c, BOARDS) && !emptyOf(c, CLEARS)) continue;
    const box = COUNTERS.find((x) => x.source === raw);
    if (box) return { counter: box.idx, action: 'act' };
  }
  return null;
}

// ---------- movement ----------

const cellKey = (x: number, z: number): number => z * POD_W + x;

/** Next cell on the shortest floor path from (sx,sz) to any floor cell beside `counter`. */
export function route(sx: number, sz: number, counter: Counter): { tx: number; tz: number; nx: number; nz: number } | null {
  const goals = new Set<number>();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const gx = counter.x + dx, gz = counter.z + dz;
    if (counterAt(gx, gz) === -1) goals.add(cellKey(gx, gz));
  }
  const prev = new Map<number, number>([[cellKey(sx, sz), -1]]);
  const queue = [cellKey(sx, sz)];
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    if (goals.has(cur)) {
      let k = cur, first = cur;
      while (prev.get(k)! !== -1) { first = k; k = prev.get(k)!; }
      return { tx: cur % POD_W, tz: Math.floor(cur / POD_W), nx: first % POD_W, nz: Math.floor(first / POD_W) };
    }
    const x = cur % POD_W, z = Math.floor(cur / POD_W);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= POD_W || nz >= POD_H || counterAt(nx, nz) !== -1) continue;
      const key = cellKey(nx, nz);
      if (prev.has(key)) continue;
      prev.set(key, cur);
      queue.push(key);
    }
  }
  return null;
}

const sign = (d: number, dead: number): -1 | 0 | 1 => (d > dead ? 1 : d < -dead ? -1 : 0);

// ---------- cards ----------

function pickCard(s: State, i: number): Input | null {
  const c = s.chefs[i];
  const b = c.bot!;
  if (s.tick < c.cdUntil || s.tick < secs(10)) return null;
  // shield up if someone hit us recently
  const recentlyHit = s.sab.some((x) => x.target === i && s.tick - x.tick < secs(12));
  if (recentlyHit && !c.shield && canCast(s, i, 'bamboo_shield', i) && next(b.rng) < 0.3) return { card: 'bamboo_shield', target: i };
  if (next(b.rng) > SKILL[b.skill].aggression) return null;
  if (s.chefs.length < 2) return null;
  // the scouted rival if we have one, else the leader among rivals
  let target = b.rival >= 0 && b.rival < s.chefs.length && b.rival !== i ? b.rival : -1;
  if (target < 0) s.chefs.forEach((r, k) => { if (k !== i && (target < 0 || r.score > s.chefs[target].score)) target = k; });
  const t = s.chefs[target];
  const cooking = HEATS.some((h) => {
    const it = t.st[h.idx].item;
    return !!it && h.type !== 'pot' && isHeat(h.type) && (!!COOKS[h.type][it.k]?.burnsTo || !!BURNS[it.k]);
  });
  const plateWithProtein = [t.held, ...t.st.map((x) => x.item)].some((it) => it?.k === 'plate' && it.on!.some((k) => k === 'fish_seared' || k === 'lobster_seared'));
  const options: Card[] = [];
  if (cooking) options.push('wasabi_bomb');
  if (plateWithProtein) options.push('fish_swap');
  options.push('dull_knife', 'soy_slick', 'order_shuffle');
  const affordable = options.filter((card) => canCast(s, i, card, target));
  if (!affordable.length) return null;
  // prefer the expensive targeted cards when they apply
  const card = affordable.find((k) => CARD_INFO[k].cost >= 2) ?? affordable[Math.floor(next(b.rng) * affordable.length)];
  return { card, target };
}

// ---------- per-tick input ----------

export function botInput(s: State, i: number): Input {
  const c = s.chefs[i];
  const b = c.bot!;
  const card = pickCard(s, i) ?? {};
  if (b.wait > 0) { b.wait--; return { mx: 0, mz: 0, ...card }; }

  const goal = plan(s, i);
  if (!goal) return { mx: 0, mz: 0, ...card };
  const counter = COUNTERS[goal.counter];
  const cx = Math.floor(c.x), cz = Math.floor(c.z);
  const r = route(cx, cz, counter);
  if (!r) return { mx: 0, mz: 0, ...card };

  const atCell = r.tx === cx && r.tz === cz;
  const ox = r.nx + 0.5 - c.x, oz = r.nz + 0.5 - c.z;
  if (!atCell || Math.abs(ox) > 0.12 || Math.abs(oz) > 0.12) {
    return { mx: sign(ox, 0.1), mz: sign(oz, 0.1), ...card };
  }
  // standing beside the counter: face it and use it in the same tick
  const fx = Math.sign(counter.x - cx) as -1 | 0 | 1;
  const fz = Math.sign(counter.z - cz) as -1 | 0 | 1;
  const { reaction, chopEvery } = SKILL[b.skill];
  b.wait = goal.action === 'chop' ? chopEvery : reaction;
  return goal.action === 'chop' ? { mx: fx, mz: fz, chop: true, ...card } : { mx: fx, mz: fz, act: true, ...card };
}
