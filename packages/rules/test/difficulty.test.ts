import { describe, expect, it } from 'vitest';
import { PROFILES, createState, replay, rulesOf, seedTag, stateHash, step, taggedSeed, type Setup } from '../src/index.ts';
import { balanceSetup, humanShift, summarize } from '../src/balance.ts';

const v2 = (difficulty: 'easy' | 'normal' | 'hard', seed = 'x'): Setup => ({
  seed: taggedSeed(seed, difficulty), rulesVersion: 2, difficulty,
  chefs: [{ name: 'me' }, { name: 'a', bot: difficulty }, { name: 'b', bot: difficulty }],
});

describe('AI chef difficulty profiles', () => {
  it('get faster, cleaner and meaner from easy to hard', () => {
    const { easy, normal, hard } = PROFILES;
    for (const [lo, hi] of [[easy, normal], [normal, hard]]) {
      expect(lo.reaction).toBeGreaterThan(hi.reaction);
      expect(lo.chopEvery).toBeGreaterThanOrEqual(hi.chopEvery);
      expect(lo.stride).toBeLessThanOrEqual(hi.stride);
      expect(lo.detour).toBeGreaterThanOrEqual(hi.detour);
      expect(lo.forget).toBeGreaterThanOrEqual(hi.forget);
      expect(lo.fumble).toBeGreaterThan(hi.fumble);
      expect(lo.dazed).toBeGreaterThan(hi.dazed); // slower to recover from sabotage
      expect(lo.cardsPerMin).toBeLessThan(hi.cardsPerMin);
      expect(lo.firstCard).toBeGreaterThan(hi.firstCard);
      expect(lo.focus).toBeLessThan(hi.focus); // hard chefs gang up on the leader
    }
    expect(hard.focus).toBe(1);
  });

  it('a reference human wins about 60% / 40% / 20% against three easy / normal / hard chefs', () => {
    // 100 seeded shifts each, seeds the profiles were not tuned on; deterministic
    const rate = (lv: 'easy' | 'normal' | 'hard') => summarize(Array.from({ length: 100 }, (_, n) => humanShift(balanceSetup(lv, 1000 + n)))).winRate;
    const [e, n, h] = [rate('easy'), rate('normal'), rate('hard')];
    expect(e).toBeGreaterThanOrEqual(0.5); expect(e).toBeLessThanOrEqual(0.7);
    expect(n).toBeGreaterThanOrEqual(0.3); expect(n).toBeLessThanOrEqual(0.5);
    expect(h).toBeGreaterThanOrEqual(0.1); expect(h).toBeLessThanOrEqual(0.3);
    // and the old (v1) line-up was out of reach
    expect(summarize(Array.from({ length: 20 }, (_, k) => humanShift(balanceSetup('v1', 1000 + k)))).winRate).toBe(0);
  }, 60_000);
});

describe('rules versions', () => {
  it('the seed commits to the rules version and difficulty', () => {
    expect(seedTag('3f9a')).toEqual({ rulesVersion: 1 });
    expect(seedTag(taggedSeed('3f9a', 'easy'))).toEqual({ rulesVersion: 2, difficulty: 'easy' });
    expect(seedTag(taggedSeed('3f9a'))).toEqual({ rulesVersion: 2, difficulty: undefined });
    expect(rulesOf({ seed: '3f9a', chefs: [] })).toBe(1);
    expect(rulesOf(v2('hard'))).toBe(2);
    expect(() => seedTag('v9.3f9a')).toThrow(/unknown rules version/);
  });

  it('refuses a setup that disagrees with its seed', () => {
    expect(() => createState({ ...v2('easy'), rulesVersion: undefined })).toThrow(/commits to v2/);
    expect(() => createState({ ...v2('easy'), difficulty: 'hard' })).toThrow(/commits to easy/);
    expect(() => createState({ seed: '3f9a', rulesVersion: 2, chefs: [{ name: 'a' }] })).toThrow(/commits to v1/);
    const s = v2('easy');
    s.chefs[1].bot = 'hard';
    expect(() => createState(s)).toThrow(/every AI chef plays at easy/);
  });

  it('v2 shifts replay to the same hash, and differ from v1 on the same seed material', () => {
    const setup = v2('normal', 'replay');
    const a = replay(setup, []);
    expect(a.v).toBe(2);
    expect(stateHash(a)).toBe(stateHash(replay(setup, [])));
    expect(a.chefs[1].delivered).toBeGreaterThan(0);
    const old = replay({ seed: 'replay', chefs: setup.chefs }, []);
    expect(old.v).toBe(1);
    expect(stateHash(old)).not.toBe(stateHash(a));
  });

  it('a chef who leaves a v2 room is taken over at the room difficulty, with v2 bots', () => {
    const s = createState(v2('easy', 'takeover'));
    step(s, [{ takeover: 'easy' }]);
    expect(s.chefs[0].bot).toMatchObject({ v: 2, skill: 'easy' });
  });
});
