import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay, stateHash, type LogEntry, type Setup } from '../src/index.ts';

// Matches played on rules v2 (AI chef difficulty, before chef upgrades) must replay to the exact
// state hash they settled with, forever. These were recorded on main at 1d39dea, before rules v3,
// with the reference human playing seat 0 (one of them leaves mid-shift and an AI chef takes over).
interface Fixture { name: string; source: string; setup: Setup; log: LogEntry[]; stateHash: string; delivered: number[]; sabotages: number }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/v2-replays.json', import.meta.url), 'utf8')) as Fixture[];

describe('rules v2 replays are frozen', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      expect(f.setup.rulesVersion).toBe(2);
      expect(f.setup.seed.startsWith('v2.')).toBe(true);
      const s = replay(f.setup, f.log);
      expect(s.v).toBe(2);
      expect(s.chefs.some((c) => 'gear' in c || 'cuts' in c)).toBe(false);
      expect(s.chefs.map((c) => c.delivered)).toEqual(f.delivered);
      expect(s.sab).toHaveLength(f.sabotages);
      expect(stateHash(s)).toBe(f.stateHash);
    });
  }
});
