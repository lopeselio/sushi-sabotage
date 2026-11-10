import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay, stateHash, type LogEntry, type Setup } from '../src/index.ts';

// Matches played before rules v2 have no rulesVersion in their setup. They must replay to the
// exact state hash they settled with, forever: these fixtures were recorded on main before the
// AI chef difficulty change (one is a live league match settled on testnet).
interface Fixture { name: string; source: string; setup: Setup; log: LogEntry[]; stateHash: string; delivered: number[]; sabotages: number }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/v1-replays.json', import.meta.url), 'utf8')) as Fixture[];

describe('rules v1 replays are frozen', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      expect(f.setup).not.toHaveProperty('rulesVersion');
      const s = replay(f.setup, f.log);
      expect(s.chefs.map((c) => c.delivered)).toEqual(f.delivered);
      expect(s.sab).toHaveLength(f.sabotages);
      expect(stateHash(s)).toBe(f.stateHash);
    });
  }
});
