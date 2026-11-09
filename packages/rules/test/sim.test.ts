import { describe, expect, it } from 'vitest';
import {
  BOMB_LEFT, BURNS, COOKS, COUNTERS, RECIPES, SCORE, SHIFT_TICKS, counterAt, createState, haggle, listPrice, recipeFor,
  replay, results, sealOf, stateHash, step, viewFor, type Input, type LogEntry, type State,
} from '../src/index.ts';

const solo = (n = 1): State => createState({ seed: 't', chefs: Array.from({ length: n }, (_, i) => ({ name: `c${i}` })) });

/** Stand chef i on the floor cell beside counter (x,z) and face it. */
function standAt(s: State, i: number, x: number, z: number): void {
  const c = s.chefs[i];
  for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    if (counterAt(x + dx, z + dz) === -1) {
      c.x = x + dx + 0.5; c.z = z + dz + 0.5; c.fx = -dx; c.fz = -dz; return;
    }
  }
  throw new Error(`no floor beside ${x},${z}`);
}
const at = (type: string, n = 0) => COUNTERS.filter((c) => c.type === type)[n];
const press = (s: State, i: number, inp: Input) => { const a: (Input | undefined)[] = []; a[i] = inp; return step(s, a); };

describe('content', () => {
  it('has 20 recipes with distinct ingredient sets', () => {
    expect(RECIPES).toHaveLength(20);
    const keys = new Set(RECIPES.map((r) => [...r.ingredients].sort().join()));
    expect(keys.size).toBe(20);
    expect(RECIPES[0].name).toBe('Azure Fin Maki');
    expect(recipeFor(['fish_seared', 'nori_roll', 'sushi_rice'])?.name).toBe('Azure Fin Maki');
  });
  it('every station is reachable from the floor', () => {
    for (const c of COUNTERS) {
      if (c.type === 'clear') continue;
      const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => counterAt(c.x + dx, c.z + dz) === -1);
      expect(ok, `${c.type} at ${c.x},${c.z}`).toBe(true);
    }
  });
});

describe('stations', () => {
  it('cuts, cooks and burns', () => {
    const s = solo();
    const c = s.chefs[0];
    const board = at('board');
    c.held = { k: 'fish' };
    standAt(s, 0, board.x, board.z);
    press(s, 0, { act: true });
    for (let k = 0; k < 3; k++) press(s, 0, { chop: true });
    expect(c.st[board.idx].item?.k).toBe('fish_sliced');
    press(s, 0, { act: true });
    const pan = at('pan');
    standAt(s, 0, pan.x, pan.z);
    press(s, 0, { act: true });
    const cook = COOKS.pan.fish_sliced!;
    for (let k = 0; k < cook.ticks; k++) step(s);
    expect(c.st[pan.idx].item?.k).toBe('fish_seared');
    for (let k = 0; k < cook.burnTicks!; k++) step(s);
    expect(c.st[pan.idx].item?.k).toBe('fish_burnt');
    expect(c.burns).toBe(1);
  });

  it('plates take each ingredient once and one protein', () => {
    const s = solo();
    const c = s.chefs[0];
    const clear = COUNTERS.find((x) => x.type === 'clear' && x.x === 4 && x.z === 3)!;
    c.st[clear.idx].item = { k: 'plate', on: [] };
    standAt(s, 0, clear.x, clear.z);
    for (const k of ['sushi_rice', 'sushi_rice', 'fish_seared', 'lobster_seared'] as const) {
      c.held = { k };
      press(s, 0, { act: true });
    }
    expect(c.st[clear.idx].item?.on).toEqual(['sushi_rice', 'fish_seared']);
  });

  it('delivers a matching dish for points and mischief', () => {
    const s = solo();
    const c = s.chefs[0];
    step(s); // first order arrives
    const recipe = RECIPES[c.orders[0].recipe];
    c.held = { k: 'plate', on: [...recipe.ingredients] };
    const hatch = at('delivery');
    standAt(s, 0, hatch.x, hatch.z);
    const ev = press(s, 0, { act: true });
    expect(ev.some((e) => e.t === 'deliver')).toBe(true);
    expect(c.delivered).toBe(1);
    expect(c.mischief).toBe(1);
    expect(c.score).toBeGreaterThanOrEqual(SCORE.base + SCORE.perIngredient * recipe.ingredients.length);
    expect(c.orders).toHaveLength(0);
  });

  it('a wrong dish costs points and resets the streak', () => {
    const s = solo();
    step(s);
    const c = s.chefs[0];
    c.streak = 4;
    c.held = { k: 'plate', on: ['sushi_rice'] };
    const hatch = at('delivery');
    standAt(s, 0, hatch.x, hatch.z);
    press(s, 0, { act: true });
    expect(c.score).toBe(SCORE.wrongDish);
    expect(c.streak).toBe(0);
  });
});

describe('sabotage', () => {
  it('wasabi bomb pushes a cooking pan to about-to-burn', () => {
    const s = solo(2);
    s.tick = 1000;
    const pan = at('pan');
    s.chefs[1].st[pan.idx].item = { k: 'fish_sliced' };
    s.chefs[0].mischief = 2;
    press(s, 0, { card: 'wasabi_bomb', target: 1 });
    const st = s.chefs[1].st[pan.idx];
    expect(st.item?.k).toBe('fish_seared');
    expect(BURNS.fish_seared!.ticks - st.p).toBeLessThanOrEqual(BOMB_LEFT);
    expect(s.chefs[0].mischief).toBe(0);
    expect(s.sab[0]).toMatchObject({ caster: 0, target: 1, card: 'wasabi_bomb', blocked: false, fizzled: false });
  });

  it('fish swap changes the protein on a plate in progress', () => {
    const s = solo(2);
    s.tick = 1000;
    s.chefs[1].held = { k: 'plate', on: ['sushi_rice', 'fish_seared'] };
    s.chefs[0].loadout = { fish_swap: 1 };
    press(s, 0, { card: 'fish_swap', target: 1 });
    expect(s.chefs[1].held?.on).toEqual(['sushi_rice', 'lobster_seared']);
    expect(s.chefs[0].loadout.fish_swap).toBe(0);
  });

  it('a shield blocks one card and the caster still pays', () => {
    const s = solo(2);
    s.tick = 1000;
    s.chefs[1].mischief = 1;
    press(s, 1, { card: 'bamboo_shield', target: 1 });
    expect(s.chefs[1].shield).toBe(true);
    s.chefs[0].mischief = 1;
    press(s, 0, { card: 'soy_slick', target: 1 });
    expect(s.chefs[1].shield).toBe(false);
    expect(s.chefs[1].slowUntil).toBe(0);
    expect(s.chefs[0].mischief).toBe(0);
    expect(s.sab[0].blocked).toBe(true);
  });

  it('cannot cast without charges, on cooldown or at yourself', () => {
    const s = solo(2);
    s.tick = 1000;
    press(s, 0, { card: 'soy_slick', target: 1 });
    expect(s.sab).toHaveLength(0);
    s.chefs[0].mischief = 5;
    press(s, 0, { card: 'soy_slick', target: 0 });
    expect(s.sab).toHaveLength(0);
    press(s, 0, { card: 'soy_slick', target: 1 });
    press(s, 0, { card: 'dull_knife', target: 1 });
    expect(s.sab).toHaveLength(1);
  });

  it('a viewer never sees who sabotaged them', () => {
    const s = solo(3);
    s.tick = 1000;
    s.chefs[0].mischief = 1;
    press(s, 0, { card: 'soy_slick', target: 1 });
    expect(viewFor(s, 1).sab[0].caster).toBe(-1);
    expect(viewFor(s, 0).sab[0].caster).toBe(0);
    expect(viewFor(s, 1).chefs[0].mischief).toBe(-1);
  });

  it('accusations score right, wrong and caught', () => {
    const s = solo(3);
    s.sab.push({ tick: 1, caster: 0, target: 1, card: 'soy_slick', blocked: false, fizzled: false });
    s.sab.push({ tick: 2, caster: 0, target: 2, card: 'dull_knife', blocked: false, fizzled: false });
    const r = results(s, [
      { victim: 1, sab: 0, accused: 0 },
      { victim: 2, sab: 1, accused: 1 },
      { victim: 2, sab: 0, accused: 0 }, // not their sabotage: ignored
    ]);
    expect(r[1].accuseDelta).toBe(SCORE.accuseRight);
    expect(r[0].accuseDelta).toBe(SCORE.caught);
    expect(r[2].accuseDelta).toBe(SCORE.accuseWrong);
  });

  it('seal format is stable', () => {
    expect(sealOf({ match: 'm1', caster: 0, target: 1, card: 'soy_slick', tick: 42, salt: 'ab' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('determinism', () => {
  it('bots-only shifts replay to the same hash', () => {
    const setup = { seed: 'replay', chefs: [{ name: 'a', bot: 'hard' as const }, { name: 'b', bot: 'normal' as const }, { name: 'c', bot: 'easy' as const }] };
    const a = replay(setup, []);
    const b = replay(setup, []);
    expect(a.tick).toBe(SHIFT_TICKS);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(a.chefs[0].delivered).toBeGreaterThan(3);
  });

  it('a human input log replays exactly', () => {
    const setup = { seed: 'human', chefs: [{ name: 'me' }, { name: 'bot', bot: 'normal' as const }] };
    const log: LogEntry[] = [];
    // walk around and press things on a fixed schedule
    for (let t = 0; t < SHIFT_TICKS; t += 15) {
      const k = t / 15;
      log.push({ t, c: 0, i: { mx: ([-1, 0, 1] as const)[k % 3], mz: ([1, -1, 0] as const)[k % 3], act: k % 4 === 0, chop: k % 5 === 0 } });
    }
    expect(stateHash(replay(setup, log))).toBe(stateHash(replay(setup, log)));
  });
});

describe('market', () => {
  it('prices rise with demand and decay', () => {
    const now = 10_000_000;
    const base = listPrice('soy_slick', [], now);
    const hot = listPrice('soy_slick', [now - 1, now - 2, now - 3], now);
    expect(hot).toBeGreaterThan(base);
    expect(listPrice('soy_slick', [now - 2 * 3600_000], now)).toBe(base);
  });
  it('haggles once, never under the floor', () => {
    expect(haggle(100, 120, 0)).toEqual({ kind: 'accept', price: 100 });
    expect(haggle(100, 40, 0)).toEqual({ kind: 'counter', price: 80 });
    expect(haggle(100, 90, 0)).toEqual({ kind: 'counter', price: 95 });
    expect(haggle(100, 85, 1)).toEqual({ kind: 'accept', price: 85 });
    expect(haggle(100, 50, 1).kind).toBe('refuse');
  });
});
