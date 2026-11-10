import { replay, type Result } from '@sushi/rules';
import { CHEF_AGENTS, logAct } from './agents.ts';
import { config } from './config.ts';
import { ChainMatch, planSeats, type SeatPlan } from './match.ts';
import { kvGet, kvSet } from './store.ts';

// The AI league: every LEAGUE_MINUTES three AI chefs play a full shift against each other with no
// human involved. The sim runs headless (same rules, same seed commitment, same seals), entry fees
// go into the pot, prizes and recipe-scroll royalties are paid by the contract, and the season
// leaderboard moves. The economy keeps going when nobody is playing.

export const LEAGUE_MINUTES = Number(process.env.LEAGUE_MINUTES ?? 15);

let running = false;

/** Rotate who sits out: a different trio each round. */
function lineup(round: number): SeatPlan[] {
  const out = CHEF_AGENTS.filter((_, k) => k !== round % CHEF_AGENTS.length);
  return out.map((a) => ({ name: a.name, kind: 'bot', agent: a }));
}

export async function leagueRound(): Promise<{ id: string; ranked: boolean; results: Result[] } | null> {
  if (running || !config.chainEnabled) return null;
  running = true;
  try {
    const round = kvGet<number>('leagueRound', 0);
    kvSet('leagueRound', round + 1);
    const { seats, fee } = await planSeats(lineup(round), { league: true });
    if (!seats.some((s) => s.chef)) return null;
    // no difficulty: league shifts stay on rules v1, each AI chef at its persona skill (Kenji hard,
    // Mei and Hana normal, Tomo easy), exactly the bots the league has always played with
    const match = new ChainMatch('league', seats, fee);
    // AI chefs only: the whole shift is decided by the bots, so it replays from an empty input log
    const s = replay(match.setup, []);
    match.noteSabotage(s);
    const { results, settled } = match.finish(s, match.botAccusations(s));
    await settled;
    const winner = [...results].sort((a, b) => a.rank - b.rank)[0];
    const tx = match.rec.txs.find((t) => t.what === 'settle_match')?.hash;
    logAct('League', `${fee ? 'ranked' : 'friendly'} shift ${match.id}: ${winner?.name} wins with ${winner?.final}${fee ? ` (pot ${fee * seats.length} ryo)` : ''}`, tx);
    return { id: match.id, ranked: fee > 0, results };
  } catch (e) {
    logAct('League', `round failed: ${(e as Error).message.slice(0, 160)}`);
    return null;
  } finally {
    running = false;
  }
}

export function startLeague(): void {
  if (!config.chainEnabled || LEAGUE_MINUTES <= 0) return;
  setTimeout(() => void leagueRound(), 60_000);
  setInterval(() => void leagueRound(), LEAGUE_MINUTES * 60_000).unref();
}
