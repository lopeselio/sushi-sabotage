import { call } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { allMatches, saveMatch, type MatchRecord } from './store.ts';

// Every byte the contract stores locks NEAR, and the AI league settles a match every 15 minutes.
// Once a league round is 12 hours old the referee asks the contract to free its record
// (prune_matches): the full record stays in the round's MatchCreated, Sealed and Settled events and in
// the proof bundle here, which says when and in which transaction it was pruned. Matches with people
// in them (solo shifts, rooms) are never pruned, so `pnpm verify` keeps working on them.

export const PRUNE_AFTER_MS = 12 * 3_600_000;
const BATCH = 40;

/** League rounds that are settled, old enough, and not pruned yet. */
export function prunable(matches: MatchRecord[], now: number): MatchRecord[] {
  return matches.filter((m) => m.mode === 'league' && m.settled && !m.pruned && m.seats.every((s) => s.kind === 'bot') && now - m.createdAt > PRUNE_AFTER_MS + 10 * 60_000);
}

export async function pruneTick(now = Date.now()): Promise<number> {
  if (!config.chainEnabled) return 0;
  const due = prunable(allMatches(), now).slice(0, BATCH);
  if (!due.length) return 0;
  const r = await call<string[]>(config.referee, 'prune_matches', { match_ids: due.map((m) => m.id) }, 100);
  const gone = new Set(r.value ?? []);
  for (const m of due) {
    if (!gone.has(m.id)) continue;
    m.pruned = { at: now, tx: r.tx };
    saveMatch(m);
  }
  console.log(`pruned ${gone.size} league match(es) from contract storage: ${explorerTx(r.tx)}`);
  return gone.size;
}

export function startPruning(): void {
  if (!config.chainEnabled || process.env.PRUNE === '0') return;
  const tick = (): void => { void pruneTick().catch((e) => console.warn('prune:', (e as Error).message.slice(0, 200))); };
  setTimeout(tick, 2 * 60_000);
  setInterval(tick, 30 * 60_000).unref();
}
