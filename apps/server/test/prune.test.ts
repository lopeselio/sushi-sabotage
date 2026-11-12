import { describe, expect, it } from 'vitest';
import { PRUNE_AFTER_MS, prunable } from '../src/prune.ts';
import type { MatchRecord } from '../src/store.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const rec = (over: Partial<MatchRecord>): MatchRecord => ({
  id: 'm', mode: 'league', createdAt: NOW - PRUNE_AFTER_MS - 3600_000, setup: { seed: 's', chefs: [] }, seedHash: '', fee: 0, ranked: false,
  seats: [{ chef: 'chef-0', name: 'Kenji', kind: 'bot' }], log: [], seals: [], openings: [], accusations: [], txs: [], lines: [], settled: true, ...over,
});

describe('which matches the referee prunes', () => {
  it('settled league rounds older than 12 h, ranked or not', () => {
    expect(prunable([rec({ id: 'a' }), rec({ id: 'b', ranked: true, fee: 10 })], NOW).map((m) => m.id)).toEqual(['a', 'b']);
  });
  it('never a match with people in it, an unsettled, young or already pruned one', () => {
    const keep = [
      rec({ mode: 'solo', seats: [{ chef: null, name: 'You', kind: 'guest' }] }),
      rec({ mode: 'room' }),
      rec({ settled: false }),
      rec({ createdAt: NOW - 3600_000 }),
      rec({ pruned: { at: NOW, tx: 'x' } }),
    ];
    expect(prunable(keep, NOW)).toEqual([]);
  });
});
