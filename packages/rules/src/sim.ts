import {
  BASES, BOMB_LEFT, BURNS, BURNT, CARD_COOLDOWN, CARD_INFO, CARDS, CHEF_RADIUS, COOKS, CUTS, DULL_EXTRA_CHOPS, DULL_TICKS,
  MISCHIEF_MAX, MOVE_SPEED, ORDER_EVERY, ORDERS_MAX, PLATE_EVERY, PLATEABLE, PLATES_MAX, PROTEINS, RECIPES, SCORE,
  SHIFT_TICKS, SHUFFLE_TICKS, SLICK_SPEED, SLICK_TICKS, TICK_HZ, patienceFor, recipeFor,
  type Card, type ItemKind,
} from './content.ts';
import { COUNTERS, SPAWN, counterAt, isHeat, type CounterType } from './layout.ts';
import { int, next, seedFrom, type Rng } from './rng.ts';
import { canonical, sha256Hex } from './hash.ts';
import { botInput, newBot, type BotSkill, type BotState } from './bot.ts';
import { botInputV2, newBotV2, type BotV2 } from './bot2.ts';
import { apronTicks, burnWindow, cleanGear, gearLevel, knifeChance, walkMult, type Gear } from './gear.ts';

// Deterministic kitchen simulation. No Math.random, no Date, no DOM.
// The same (setup, input log) always produces the same state and hash.

export interface Item { k: ItemKind; on?: ItemKind[] }
export interface Station { item: Item | null; p: number }
export interface Order { id: number; recipe: number; born: number; due: number }

export interface Input {
  mx?: -1 | 0 | 1;
  mz?: -1 | 0 | 1;
  act?: boolean;
  chop?: boolean;
  card?: Card;
  target?: number;
  /** an AI chef takes over this pod from now on (the human left); logged so replays match */
  takeover?: BotSkill;
}

export interface Chef {
  name: string;
  bot: BotState | BotV2 | null;
  x: number; z: number;
  fx: number; fz: number;
  mx: -1 | 0 | 1; mz: -1 | 0 | 1;
  held: Item | null;
  st: Station[];
  plates: number; plateT: number;
  orders: Order[];
  mischief: number;
  loadout: Partial<Record<Card, number>>;
  cdUntil: number;
  shield: boolean;
  slowUntil: number;
  dullUntil: number;
  score: number; streak: number; bestStreak: number;
  delivered: number; burns: number; trashed: number; expired: number; wrong: number;
  dishes: number[]; // recipe ids delivered, in order
  hits: number; // sabotages landed on rivals
  /** rules v3: the chef NFT's upgrade levels (absent when it has none, so v1/v2 states hash as before) */
  gear?: Gear;
  /** rules v3, with a knife: chops made so far (numbers the knife's rolls) */
  cuts?: number;
}

export interface Sabotage {
  tick: number;
  caster: number;
  target: number;
  card: Card;
  blocked: boolean;
  fizzled: boolean;
}

export interface State {
  /** rules version: 1 = before AI chef difficulty (frozen), 2 = AI difficulty (frozen), 3 = + chef upgrades */
  v: RulesVersion;
  seed: string;
  tick: number;
  rng: Rng;
  rail: number[];
  railIdx: number;
  chefs: Chef[];
  sab: Sabotage[];
  over: boolean;
}

export type SimEvent =
  | { t: 'deliver'; chef: number; recipe: number; points: number; tip: number }
  | { t: 'wrong'; chef: number }
  | { t: 'expire'; chef: number; recipe: number }
  | { t: 'burn'; chef: number; counter: number }
  | { t: 'cooked'; chef: number; counter: number }
  | { t: 'chop'; chef: number; counter: number }
  | { t: 'pick'; chef: number; counter: number }
  | { t: 'place'; chef: number; counter: number }
  | { t: 'trash'; chef: number; counter: number }
  | { t: 'serve'; chef: number; counter: number }
  | { t: 'order'; chef: number; recipe: number }
  | { t: 'cast'; caster: number; target: number; card: Card }
  | { t: 'sabotaged'; caster: number; target: number; card: Card; blocked: boolean; fizzled: boolean }
  | { t: 'over' };

export interface ChefSetup {
  name: string;
  bot?: BotSkill;
  loadout?: Partial<Record<Card, number>>;
  /** a bot's preferred sabotage target (seat index), e.g. from a scouting report it bought */
  rival?: number;
  /** rules v3: the chef NFT's upgrade levels, as recorded by the contract at create_match */
  gear?: Gear;
}

export type RulesVersion = 1 | 2 | 3;
export const RULES_VERSION: RulesVersion = 3;
export const DIFFICULTIES: readonly BotSkill[] = ['easy', 'normal', 'hard'];

export interface Setup {
  seed: string;
  chefs: ChefSetup[];
  /** missing = 1: the rules every match before v2 was played under, kept exactly */
  rulesVersion?: RulesVersion;
  /** the AI chef difficulty the host picked (v2); every bot seat plays at it */
  difficulty?: BotSkill;
}

/**
 * The seed carries the rules version and difficulty, so they're committed with the seed hash at
 * create_match: "v2.normal.<hex>" (rooms and solo) or "v2.<hex>" (league, bots at their own level).
 * An untagged seed is rules v1.
 */
export const taggedSeed = (hex: string, difficulty?: BotSkill, v: RulesVersion = RULES_VERSION): string => `v${v}.${difficulty ? `${difficulty}.` : ''}${hex}`;

export function seedTag(seed: string): { rulesVersion: RulesVersion; difficulty?: BotSkill } {
  const m = /^v(\d+)\.(?:(easy|normal|hard)\.)?/.exec(seed);
  if (!m) return { rulesVersion: 1 };
  if (m[1] !== '2' && m[1] !== '3') throw new Error(`unknown rules version v${m[1]}`);
  return { rulesVersion: Number(m[1]) as RulesVersion, difficulty: m[2] as BotSkill | undefined };
}

/** The setup's rules version, after checking it against what its seed committed to. */
export function rulesOf(setup: Setup): RulesVersion {
  const tag = seedTag(setup.seed);
  const v = setup.rulesVersion ?? 1;
  if (v !== tag.rulesVersion) throw new Error(`setup says rules v${v} but its seed commits to v${tag.rulesVersion}`);
  if (setup.difficulty !== tag.difficulty) throw new Error(`setup difficulty ${setup.difficulty ?? 'none'} but its seed commits to ${tag.difficulty ?? 'none'}`);
  if (setup.difficulty && setup.chefs.some((c) => c.bot && c.bot !== setup.difficulty)) throw new Error(`every AI chef plays at ${setup.difficulty} in this match`);
  if (v < 3 && setup.chefs.some((c) => c.gear && Object.values(c.gear).some((l) => l))) throw new Error('chef upgrades need rules v3');
  return v;
}

export const MAX_CHEFS = 4;

// ---------- setup ----------

/** The order rail: every chef gets these recipes, in this order. Shallow dishes early, deeper later. */
export function makeRail(seed: string): number[] {
  const r: Rng = { s: seedFrom(`rail:${seed}`) };
  const n = Math.floor(SHIFT_TICKS / ORDER_EVERY) + 1;
  const rail: number[] = [];
  for (let i = 0; i < n; i++) {
    const maxDepth = Math.min(4, 1 + Math.floor((4 * i) / n));
    const depth = int(r, 0, maxDepth);
    const style = int(r, 0, 1);
    const protein = int(r, 0, 1);
    rail.push(style * 10 + protein * 5 + depth);
  }
  return rail;
}

export function createState(setup: Setup): State {
  if (setup.chefs.length < 1 || setup.chefs.length > MAX_CHEFS) throw new Error(`1..${MAX_CHEFS} chefs`);
  const v = rulesOf(setup);
  const mk = v >= 2 ? newBotV2 : newBot;
  const chefs: Chef[] = setup.chefs.map((c, i) => withGear(c.gear, {
    name: c.name,
    bot: c.bot ? mk(c.bot, `${setup.seed}:${i}`, c.rival) : null,
    x: SPAWN.x, z: SPAWN.z, fx: 0, fz: -1, mx: 0, mz: 0,
    held: null,
    st: COUNTERS.map(() => ({ item: null, p: 0 })),
    plates: 2, plateT: 0,
    orders: [],
    mischief: 0,
    loadout: { ...(c.loadout ?? {}) },
    cdUntil: 0, shield: false, slowUntil: 0, dullUntil: 0,
    score: 0, streak: 0, bestStreak: 0,
    delivered: 0, burns: 0, trashed: 0, expired: 0, wrong: 0, dishes: [], hits: 0,
  }));
  return { v, seed: setup.seed, tick: 0, rng: { s: seedFrom(`sim:${setup.seed}`) }, rail: makeRail(setup.seed), railIdx: 0, chefs, sab: [], over: false };
}

/** v3 chefs with upgrades carry them (and a chop counter for the knife); everyone else is unchanged. */
function withGear(g: Gear | undefined, c: Chef): Chef {
  const gear = g ? cleanGear(g) : {};
  if (!Object.keys(gear).length) return c;
  c.gear = gear;
  if (gear.knife) c.cuts = 0;
  return c;
}

// ---------- helpers shared with the bot and renderer ----------

const COLLIDE_R2 = CHEF_RADIUS * CHEF_RADIUS;

function collides(x: number, z: number): boolean {
  const x0 = Math.floor(x - CHEF_RADIUS), x1 = Math.floor(x + CHEF_RADIUS);
  const z0 = Math.floor(z - CHEF_RADIUS), z1 = Math.floor(z + CHEF_RADIUS);
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (counterAt(cx, cz) === -1) continue;
      const px = Math.max(cx, Math.min(x, cx + 1));
      const pz = Math.max(cz, Math.min(z, cz + 1));
      const dx = x - px, dz = z - pz;
      if (dx * dx + dz * dz < COLLIDE_R2) return true;
    }
  }
  return false;
}

/** The counter the chef is facing (within reach), or -1. */
export function facingCounter(c: Pick<Chef, 'x' | 'z' | 'fx' | 'fz'>): number {
  const len = Math.sqrt(c.fx * c.fx + c.fz * c.fz) || 1;
  const ux = c.fx / len, uz = c.fz / len;
  for (const d of [0.45, 0.75, 1.05]) {
    const idx = counterAt(Math.floor(c.x + ux * d), Math.floor(c.z + uz * d));
    if (idx >= 0) return idx;
    if (idx === -2) return -1;
  }
  return -1;
}

export function canAddToPlate(on: readonly ItemKind[], k: ItemKind): boolean {
  if (!PLATEABLE.has(k) || on.includes(k)) return false;
  if (BASES.has(k) && on.some((i) => BASES.has(i))) return false;
  if (PROTEINS.has(k) && on.some((i) => PROTEINS.has(i))) return false;
  return true;
}


/** Whether a holding station accepts an item placed on it. */
export function accepts(t: CounterType, item: Item): boolean {
  if (t === 'clear') return true;
  if (t === 'board') return CUTS[item.k] !== undefined;
  if (isHeat(t)) return COOKS[t][item.k] !== undefined;
  return false;
}

export const chopsNeeded = (c: Chef, k: ItemKind, tick: number): number =>
  (CUTS[k]?.chops ?? 0) + (tick < c.dullUntil ? DULL_EXTRA_CHOPS : 0);

/** 0..1 progress of a station for UI, and whether it's in the burn phase. */
export function stationProgress(c: Chef, idx: number, tick: number): { p: number; burning: boolean } | null {
  const s = c.st[idx];
  const t = COUNTERS[idx].type;
  if (!s.item) return null;
  if (t === 'board') {
    const need = chopsNeeded(c, s.item.k, tick);
    return need ? { p: s.p / need, burning: false } : null;
  }
  if (isHeat(t)) {
    const cook = COOKS[t][s.item.k];
    if (cook) return { p: s.p / cook.ticks, burning: false };
    const burn = BURNS[s.item.k];
    if (burn) return { p: s.p / burnWindow(burn.ticks, gearLevel(c.gear, 'pan')), burning: true };
  }
  return null;
}

const isRaw = (k: ItemKind): boolean => COUNTERS.some((c) => c.source === k) && k !== 'nori_cone';

// ---------- step ----------

/**
 * Advance one tick. `inputs[i]` is chef i's input change this tick (movement persists until changed;
 * act/chop/card fire once). Bot chefs ignore `inputs` and decide for themselves.
 */
export function step(s: State, inputs: (Input | undefined)[] = []): SimEvent[] {
  if (s.over) return [];
  const ev: SimEvent[] = [];

  // orders arrive for everyone at once
  if (s.tick % ORDER_EVERY === 0 && s.railIdx < s.rail.length) {
    const recipe = s.rail[s.railIdx];
    const size = RECIPES[recipe].ingredients.length;
    s.chefs.forEach((c, i) => {
      if (c.orders.length < ORDERS_MAX) {
        c.orders.push({ id: s.railIdx, recipe, born: s.tick, due: s.tick + patienceFor(size) });
        ev.push({ t: 'order', chef: i, recipe });
      }
    });
    s.railIdx++;
  }

  for (let i = 0; i < s.chefs.length; i++) {
    const c = s.chefs[i];
    const own = inputs[i];
    if (own?.takeover && !c.bot) c.bot = (s.v >= 2 ? newBotV2 : newBot)(own.takeover, `${s.seed}:takeover:${i}`);
    const inp = c.bot ? ((c.bot as BotV2).v === 2 ? botInputV2(s, i) : botInput(s, i)) : own;
    if (inp) applyInput(s, i, inp, ev);
    moveChef(c, s.tick);
    tickStations(s, i, ev);
    tickOrders(s, i, ev);
  }

  s.tick++;
  if (s.tick >= SHIFT_TICKS) {
    s.over = true;
    ev.push({ t: 'over' });
  }
  return ev;
}

function applyInput(s: State, i: number, inp: Input, ev: SimEvent[]): void {
  const c = s.chefs[i];
  if (inp.mx !== undefined) c.mx = inp.mx;
  if (inp.mz !== undefined) c.mz = inp.mz;
  if (c.mx || c.mz) { c.fx = c.mx; c.fz = c.mz; }
  if (inp.act) interact(s, i, ev);
  if (inp.chop) chop(s, i, ev);
  if (inp.card) cast(s, i, inp.card, inp.target ?? i, ev);
}

/** One tick of movement with collision. Exported so clients can predict their own chef. */
export function moveChef(c: Chef, tick: number): void {
  if (!c.mx && !c.mz) return;
  let sp = MOVE_SPEED / TICK_HZ;
  if (tick < c.slowUntil) sp *= SLICK_SPEED;
  if (c.gear?.sandals) sp *= walkMult(c.gear.sandals);
  if (c.mx && c.mz) sp *= Math.SQRT1_2;
  const nx = c.x + c.mx * sp;
  if (!collides(nx, c.z)) c.x = nx;
  const nz = c.z + c.mz * sp;
  if (!collides(c.x, nz)) c.z = nz;
}

function interact(s: State, i: number, ev: SimEvent[]): void {
  const c = s.chefs[i];
  const idx = facingCounter(c);
  if (idx < 0) return;
  const counter = COUNTERS[idx];
  const st = c.st[idx];
  switch (counter.type) {
    case 'container':
      if (!c.held && counter.source) { c.held = { k: counter.source }; ev.push({ t: 'pick', chef: i, counter: idx }); }
      else if (c.held?.k === 'plate' && counter.source === 'nori_cone' && canAddToPlate(c.held.on!, 'nori_cone')) {
        c.held.on!.push('nori_cone'); // cones need no prep: scoop straight onto a held plate
        ev.push({ t: 'place', chef: i, counter: idx });
      }
      return;
    case 'plates':
      if (!c.held && c.plates > 0) { c.plates--; c.held = { k: 'plate', on: [] }; ev.push({ t: 'pick', chef: i, counter: idx }); }
      return;
    case 'trash': {
      const h = c.held;
      if (!h) return;
      if (h.k === 'plate') {
        if (h.on!.length) { h.on = []; c.score += SCORE.trash; c.trashed++; }
        else c.held = null;
      } else {
        if (!BURNT.has(h.k) && !isRaw(h.k)) { c.score += SCORE.trash; c.trashed++; }
        c.held = null;
      }
      ev.push({ t: 'trash', chef: i, counter: idx });
      return;
    }
    case 'delivery':
      if (c.held?.k === 'plate' && c.held.on!.length) { ev.push({ t: 'serve', chef: i, counter: idx }); deliver(s, i, c.held, ev); }
      return;
    default: {
      // clear counter, board, cooker, pan, pot: place / pick / combine with a plate
      if (!st.item && c.held && accepts(counter.type, c.held)) {
        st.item = c.held; st.p = 0; c.held = null;
        ev.push({ t: 'place', chef: i, counter: idx });
      } else if (st.item && !c.held) {
        c.held = st.item; st.item = null; st.p = 0;
        ev.push({ t: 'pick', chef: i, counter: idx });
      } else if (st.item && c.held) {
        if (c.held.k === 'plate' && canAddToPlate(c.held.on!, st.item.k)) {
          c.held.on!.push(st.item.k); st.item = null; st.p = 0;
          ev.push({ t: 'place', chef: i, counter: idx });
        } else if (st.item.k === 'plate' && canAddToPlate(st.item.on!, c.held.k)) {
          st.item.on!.push(c.held.k); c.held = null;
          ev.push({ t: 'place', chef: i, counter: idx });
        }
      }
    }
  }
}

function chop(s: State, i: number, ev: SimEvent[]): void {
  const c = s.chefs[i];
  const idx = facingCounter(c);
  if (idx < 0 || COUNTERS[idx].type !== 'board') return;
  const st = c.st[idx];
  if (!st.item) return;
  const cut = CUTS[st.item.k];
  if (!cut) return;
  const knife = gearLevel(c.gear, 'knife');
  if (knife) {
    c.cuts = (c.cuts ?? 0) + 1;
    st.p += next({ s: seedFrom(`knife:${s.seed}:${i}:${c.cuts}`) }) < knifeChance(knife) ? 2 : 1;
  } else st.p++;
  ev.push({ t: 'chop', chef: i, counter: idx });
  if (st.p >= chopsNeeded(c, st.item.k, s.tick)) { st.item = { k: cut.out }; st.p = 0; }
}

function tickStations(s: State, i: number, ev: SimEvent[]): void {
  const c = s.chefs[i];
  for (const counter of COUNTERS) {
    if (counter.type === 'plates') continue;
    if (!isHeat(counter.type)) continue;
    const st = c.st[counter.idx];
    if (!st.item) continue;
    st.p++;
    const cook = COOKS[counter.type][st.item.k];
    if (cook) {
      if (st.p >= cook.ticks) { st.item = { k: cook.out }; st.p = 0; ev.push({ t: 'cooked', chef: i, counter: counter.idx }); }
      continue;
    }
    const burn = BURNS[st.item.k];
    if (burn && st.p >= burnWindow(burn.ticks, gearLevel(c.gear, 'pan'))) {
      st.item = { k: burn.to }; st.p = 0;
      c.burns++; c.score += SCORE.burn;
      ev.push({ t: 'burn', chef: i, counter: counter.idx });
    }
  }
  c.plateT++;
  if (c.plateT >= PLATE_EVERY) { c.plateT = 0; if (c.plates < PLATES_MAX) c.plates++; }
}

function tickOrders(s: State, i: number, ev: SimEvent[]): void {
  const c = s.chefs[i];
  for (let k = c.orders.length - 1; k >= 0; k--) {
    const o = c.orders[k];
    if (s.tick >= o.due) {
      c.orders.splice(k, 1);
      c.expired++; c.score += SCORE.expired; c.streak = 0;
      ev.push({ t: 'expire', chef: i, recipe: o.recipe });
    }
  }
}

export function streakMult(streak: number): number {
  for (const s of SCORE.streak) if (streak >= s.at) return s.mult;
  return 1;
}

function deliver(s: State, i: number, plate: Item, ev: SimEvent[]): void {
  const c = s.chefs[i];
  c.held = null;
  const match = recipeFor(plate.on!);
  const k = match ? c.orders.findIndex((o) => o.recipe === match.id) : -1; // orders are oldest-first
  if (!match || k < 0) {
    c.wrong++; c.score += SCORE.wrongDish; c.streak = 0;
    ev.push({ t: 'wrong', chef: i });
    return;
  }
  const o = c.orders[k];
  c.orders.splice(k, 1);
  const base = SCORE.base + SCORE.perIngredient * match.ingredients.length;
  const left = Math.max(0, o.due - s.tick) / (o.due - o.born);
  const tip = Math.floor(base * SCORE.maxTipFraction * left);
  c.streak++;
  c.bestStreak = Math.max(c.bestStreak, c.streak);
  const points = Math.round((base + tip) * streakMult(c.streak));
  c.score += points;
  c.delivered++;
  c.dishes.push(match.id);
  c.mischief = Math.min(MISCHIEF_MAX, c.mischief + 1);
  ev.push({ t: 'deliver', chef: i, recipe: match.id, points, tip });
}

// ---------- sabotage ----------

/** Whether chef i can cast `card` right now (loadout charge or enough mischief, off cooldown). */
export function canCast(s: State, i: number, card: Card, target: number): boolean {
  const c = s.chefs[i];
  const info = CARD_INFO[card];
  if (!CARDS.includes(card) || s.over) return false;
  if (s.tick < c.cdUntil) return false;
  if (info.self ? target !== i : target === i || target < 0 || target >= s.chefs.length) return false;
  if (info.self && c.shield) return false;
  return (c.loadout[card] ?? 0) > 0 || c.mischief >= info.cost;
}

function cast(s: State, i: number, card: Card, target: number, ev: SimEvent[]): void {
  if (!canCast(s, i, card, target)) return;
  const c = s.chefs[i];
  if ((c.loadout[card] ?? 0) > 0) c.loadout[card]!--;
  else c.mischief -= CARD_INFO[card].cost;
  c.cdUntil = s.tick + CARD_COOLDOWN;
  ev.push({ t: 'cast', caster: i, target, card });

  if (card === 'bamboo_shield') { c.shield = true; return; }

  const t = s.chefs[target];
  let blocked = false, fizzled = false;
  if (t.shield) { t.shield = false; blocked = true; }
  else fizzled = !applyCard(s, t, card);
  if (!blocked && !fizzled) c.hits++;
  s.sab.push({ tick: s.tick, caster: i, target, card, blocked, fizzled });
  ev.push({ t: 'sabotaged', caster: i, target, card, blocked, fizzled });
}

function applyCard(s: State, t: Chef, card: Card): boolean {
  switch (card) {
    case 'wasabi_bomb': {
      let hit = false;
      for (const counter of COUNTERS) {
        if (counter.type !== 'cooker' && counter.type !== 'pan') continue;
        const st = t.st[counter.idx];
        if (!st.item) continue;
        const cook = COOKS[counter.type][st.item.k];
        const pan = gearLevel(t.gear, 'pan');
        if (cook?.burnsTo && cook.burnTicks) {
          st.item = { k: cook.out }; st.p = Math.max(0, burnWindow(cook.burnTicks, pan) - BOMB_LEFT); hit = true;
        } else {
          const burn = BURNS[st.item.k];
          if (burn) { st.p = Math.max(st.p, burnWindow(burn.ticks, pan) - BOMB_LEFT); hit = true; }
        }
      }
      return hit;
    }
    case 'fish_swap': {
      const plates: Item[] = [];
      if (t.held?.k === 'plate') plates.push(t.held);
      for (const st of t.st) if (st.item?.k === 'plate') plates.push(st.item);
      for (const p of plates) {
        const at = p.on!.findIndex((k) => PROTEINS.has(k));
        if (at >= 0) { p.on![at] = p.on![at] === 'fish_seared' ? 'lobster_seared' : 'fish_seared'; return true; }
      }
      return false;
    }
    case 'dull_knife': t.dullUntil = s.tick + apronTicks(DULL_TICKS, gearLevel(t.gear, 'apron')); return true;
    case 'soy_slick': t.slowUntil = s.tick + apronTicks(SLICK_TICKS, gearLevel(t.gear, 'apron')); return true;
    case 'order_shuffle': {
      const o = t.orders[0];
      if (!o) return false;
      o.due = Math.max(s.tick + 1, o.due - apronTicks(SHUFFLE_TICKS, gearLevel(t.gear, 'apron')));
      return true;
    }
    default: return false;
  }
}

// ---------- whodunit + results ----------

export interface Accusation { victim: number; sab: number; accused: number }

export interface Result {
  chef: number;
  name: string;
  shiftScore: number;
  accuseDelta: number;
  final: number;
  rank: number;
}

/** Valid accusations only: the victim's own sabotage, a real rival, at most one per sabotage. */
export function validAccusations(s: State, acc: readonly Accusation[]): Accusation[] {
  const seen = new Set<number>();
  return acc.filter((a) => {
    const sab = s.sab[a.sab];
    if (!sab || sab.target !== a.victim || seen.has(a.sab)) return false;
    if (a.accused === a.victim || a.accused < 0 || a.accused >= s.chefs.length) return false;
    seen.add(a.sab);
    return true;
  });
}

export function results(s: State, acc: readonly Accusation[]): Result[] {
  const delta = s.chefs.map(() => 0);
  for (const a of validAccusations(s, acc)) {
    const sab = s.sab[a.sab];
    if (a.accused === sab.caster) { delta[a.victim] += SCORE.accuseRight; delta[sab.caster] += SCORE.caught; }
    else delta[a.victim] += SCORE.accuseWrong;
  }
  const rows = s.chefs.map((c, i) => ({ chef: i, name: c.name, shiftScore: c.score, accuseDelta: delta[i], final: c.score + delta[i], rank: 0 }));
  const order = [...rows].sort((a, b) => b.final - a.final || a.chef - b.chef);
  order.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

/** A bot's guess at who sabotaged it: weighted towards rivals with more deliveries (more mischief), sometimes passes. */
export function botAccuse(s: State, victim: number, sabIdx: number): number | null {
  const r: Rng = { s: seedFrom(`accuse:${s.seed}:${victim}:${sabIdx}`) };
  if (next(r) < 0.25) return null;
  const rivals = s.chefs.map((_, i) => i).filter((i) => i !== victim);
  const w = rivals.map((i) => 1 + s.chefs[i].delivered);
  let roll = next(r) * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < rivals.length; k++) { roll -= w[k]; if (roll < 0) return rivals[k]; }
  return rivals[rivals.length - 1];
}

// ---------- replay ----------

/** An input log entry: chef `c` changed input at tick `t`. */
export interface LogEntry { t: number; c: number; i: Input }

export function stateHash(s: State): string {
  return sha256Hex(canonical(s));
}

/** Run a whole shift from setup + log. Used by the server to verify solo runs and by the verifier. */
export function replay(setup: Setup, log: readonly LogEntry[]): State {
  const s = createState(setup);
  let k = 0;
  const sorted = [...log].sort((a, b) => a.t - b.t || a.c - b.c);
  while (!s.over) {
    const inputs: (Input | undefined)[] = [];
    while (k < sorted.length && sorted[k].t === s.tick) {
      const e = sorted[k++];
      if (e.c >= 0 && e.c < s.chefs.length) inputs[e.c] = { ...(inputs[e.c] ?? {}), ...e.i };
    }
    // entries for ticks already past are ignored
    while (k < sorted.length && sorted[k].t < s.tick) k++;
    step(s, inputs);
  }
  return s;
}

/** Strip what a given viewer must not see: who cast each sabotage (except their own casts). */
export function viewFor(s: State, viewer: number): State {
  return {
    ...s,
    sab: s.sab.map((x) => (x.caster === viewer ? x : { ...x, caster: -1 })),
    chefs: s.chefs.map((c, i) => (i === viewer ? c : { ...c, mischief: -1, loadout: {}, bot: null })),
  };
}
