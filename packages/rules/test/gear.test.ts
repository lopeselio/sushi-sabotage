import { describe, expect, it } from 'vitest';
import {
  BOMB_LEFT, BURNS, COUNTERS, DULL_TICKS, SHUFFLE_TICKS, SLICK_TICKS, apronTicks, burnWindow, cleanGear, createState,
  gearFromArray, gearToArray, moveChef, replay, rulesOf, stateHash, step, taggedSeed, type Gear, type Setup, type State,
} from '../src/index.ts';
import { balanceSetup, humanShift, summarize } from '../src/balance.ts';

const v3 = (gear?: Gear, seed = 'g'): Setup => ({
  seed: taggedSeed(seed, 'normal'), rulesVersion: 3, difficulty: 'normal',
  chefs: [{ name: 'me', gear }, { name: 'a', bot: 'normal' }],
});
const counter = (type: string): number => COUNTERS.find((c) => c.type === type)!.idx;

/** Stand chef 0 just below a counter, facing it (the boards sit on the open centre island). */
function faceCounter(s: State, idx: number): void {
  const c = COUNTERS[idx];
  Object.assign(s.chefs[0], { x: c.x + 0.5, z: c.z + 1.5, fx: 0, fz: -1 });
}

describe('chef upgrades (rules v3)', () => {
  it('are refused before rules v3, and v3 without gear adds no fields', () => {
    const v2: Setup = { seed: taggedSeed('g', 'normal', 2), rulesVersion: 2, difficulty: 'normal', chefs: [{ name: 'me', gear: { pan: 1 } }] };
    expect(() => createState(v2)).toThrow(/need rules v3/);
    expect(rulesOf(v3())).toBe(3);
    const s = createState(v3({ knife: 0 }));
    expect(s.v).toBe(3);
    expect('gear' in s.chefs[0]).toBe(false);
    expect('cuts' in s.chefs[0]).toBe(false);
  });

  it('checks levels', () => {
    expect(cleanGear({ knife: 2, pan: 0 })).toEqual({ knife: 2 });
    expect(() => cleanGear({ knife: 6 })).toThrow(/0\.\.5/);
    expect(() => cleanGear({ knife: 4 }, 3)).toThrow(/0\.\.3/);
    expect(() => cleanGear({ wok: 1 } as Gear)).toThrow(/unknown gear/);
    expect(() => createState(v3({ sandals: 1.5 }))).toThrow();
    expect(gearToArray({ pan: 2, apron: 5 })).toEqual([0, 2, 0, 5]);
    expect(gearFromArray([1, 0, 3, 0])).toEqual({ knife: 1, sandals: 3 });
  });

  it('effects are small and exact', () => {
    const fishBurn = BURNS.fish_seared!.ticks; // 5 s
    expect(burnWindow(fishBurn, 0)).toBe(fishBurn);
    expect(burnWindow(fishBurn, 5)).toBe(Math.floor((fishBurn * 130) / 100));
    expect(apronTicks(SLICK_TICKS, 0)).toBe(SLICK_TICKS);
    expect(apronTicks(DULL_TICKS, 5)).toBe(Math.floor((DULL_TICKS * 70) / 100));
    expect(apronTicks(SHUFFLE_TICKS, 3)).toBe(Math.floor((SHUFFLE_TICKS * 82) / 100));
  });

  it('sandals: a little faster, only when upgraded', () => {
    const a = createState(v3()), b = createState(v3({ sandals: 5 }));
    for (const s of [a, b]) { s.chefs[0].mx = 1; s.chefs[0].x = 1.5; s.chefs[0].z = 1.5; }
    const x0 = a.chefs[0].x;
    moveChef(a.chefs[0], 0); moveChef(b.chefs[0], 0);
    if (a.chefs[0].x !== x0) expect((b.chefs[0].x - x0) / (a.chefs[0].x - x0)).toBeCloseTo(1.1, 6);
  });

  it('pan: seared fish waits longer before it burns, and a wasabi bomb still leaves 1.5 s', () => {
    const burnAt = (gear?: Gear): number => {
      const s = createState(v3(gear));
      const pan = counter('pan');
      s.chefs[0].st[pan] = { item: { k: 'fish_seared' }, p: 0 };
      s.chefs[1].bot = null;
      for (let t = 1; t < 400; t++) { const ev = step(s, []); if (ev.some((e) => e.t === 'burn' && e.chef === 0)) return t; }
      return -1;
    };
    expect(burnAt()).toBe(BURNS.fish_seared!.ticks);
    expect(burnAt({ pan: 5 })).toBe(burnWindow(BURNS.fish_seared!.ticks, 5));

    const s = createState(v3({ pan: 5 }));
    const pan = counter('pan');
    s.chefs[0].st[pan] = { item: { k: 'fish_seared' }, p: 0 };
    s.chefs[1].bot = null;
    s.chefs[1].mischief = 5;
    step(s, [undefined, { card: 'wasabi_bomb', target: 0 }]);
    expect(burnWindow(BURNS.fish_seared!.ticks, 5) - s.chefs[0].st[pan].p).toBeLessThanOrEqual(BOMB_LEFT);
  });

  it('apron: soy slick wears off sooner', () => {
    const slowFor = (gear?: Gear): number => {
      const s = createState(v3(gear));
      s.chefs[1].bot = null; s.chefs[1].mischief = 5;
      step(s, [undefined, { card: 'soy_slick', target: 0 }]);
      return s.chefs[0].slowUntil - (s.tick - 1);
    };
    expect(slowFor()).toBe(SLICK_TICKS);
    expect(slowFor({ apron: 5 })).toBe(apronTicks(SLICK_TICKS, 5));
  });

  it('knife: some chops count twice, the same way on every replay', () => {
    const chopsFor = (gear: Gear | undefined, seed: string): number => {
      const s = createState(v3(gear, seed));
      s.chefs[1].bot = null;
      const board = counter('board');
      faceCounter(s, board);
      let chops = 0;
      for (let n = 0; n < 30; n++) {
        s.chefs[0].st[board] = { item: { k: 'fish' }, p: 0 };
        while (s.chefs[0].st[board].item?.k === 'fish') { step(s, [{ chop: true }]); chops++; if (chops > 500) return -1; }
      }
      return chops;
    };
    expect(chopsFor(undefined, 'k')).toBe(90); // 30 fish × 3 chops
    const sharp = chopsFor({ knife: 5 }, 'k');
    expect(sharp).toBeGreaterThan(60);
    expect(sharp).toBeLessThan(85);
    expect(chopsFor({ knife: 5 }, 'k')).toBe(sharp);
  });

  it('a v3 shift with gear replays to the same hash; gear changes the hash', () => {
    const setup = v3({ knife: 3, pan: 2, sandals: 3, apron: 1 }, 'replay');
    const a = replay(setup, []);
    expect(stateHash(a)).toBe(stateHash(replay(setup, [])));
    expect(stateHash(a)).not.toBe(stateHash(replay(v3(undefined, 'replay'), [])));
  });

  it('keeps ranked fair: the ranked cap (level 3 everywhere) is worth a few points of win rate, not a sure win', () => {
    const rate = (gear: number) => summarize(Array.from({ length: 100 }, (_, n) => {
      const s = balanceSetup('normal', 1000 + n);
      if (gear) s.chefs[0].gear = { knife: gear, pan: gear, sandals: gear, apron: gear };
      return humanShift(s);
    })).winRate;
    const [none, capped] = [rate(0), rate(3)];
    expect(capped).toBeGreaterThanOrEqual(none);
    expect(capped - none).toBeLessThanOrEqual(0.12);
    expect(capped).toBeLessThanOrEqual(0.6);
  }, 60_000);
});
