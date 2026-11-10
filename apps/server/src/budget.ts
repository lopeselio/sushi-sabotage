// The AI chefs' daily budget, managed automatically.
//
// The contract caps what each AI chef may spend per UTC day (day_cap, 150 ryo) and per match entry
// (match_cap, 10 ryo), and resets the count itself each day. That cap is the agents' spending policy
// and stays as it is. What the server decides is how to spend inside it, so ranked play never runs
// dry halfway through the day:
//
// - a reserve is kept for ranked shifts against people (players can always get a ranked shift);
// - the rest is the league budget, and ranked league shifts are spread evenly over what's left of
//   the day (the rounds in between are friendly exhibitions with no fee);
// - league seats go to the chefs with the most league budget left, so they drain evenly;
// - cards and scout reports come only from what's left over after the reserve and a few league entries.
//
// Everything here is pure, so it's tested without a chain.

export const DAY_MS = 86_400_000;
/** ryo each AI chef keeps every day for ranked shifts against people (6 entries) */
export const PLAYER_RESERVE = 60;
/** league entries kept back from extras (cards, scouting) */
export const LEAGUE_KEEP = 3;

export interface AgentPolicyView { day: number; spent_today: number; day_cap: number; match_cap: number }

export interface Budget {
  /** what the contract still lets this chef spend today */
  left: number;
  /** of that, kept for ranked shifts against people */
  forPlayers: number;
  /** of that, available to the league */
  forLeague: number;
  /** league entries it can still pay today */
  leagueEntries: number;
  /** spare for cards and scout reports */
  extras: number;
}

export function budgetOf(p: AgentPolicyView | null, nowMs: number, fee: number): Budget {
  if (!p) return { left: 0, forPlayers: 0, forLeague: 0, leagueEntries: 0, extras: 0 };
  const today = Math.floor(nowMs / DAY_MS);
  const spent = p.day === today ? p.spent_today : 0;
  const left = Math.max(0, p.day_cap - spent);
  const forPlayers = Math.min(left, PLAYER_RESERVE);
  const forLeague = left - forPlayers;
  const leagueEntries = fee > 0 ? Math.floor(forLeague / fee) : 0;
  const extras = Math.max(0, forLeague - LEAGUE_KEEP * fee);
  return { left, forPlayers, forLeague, leagueEntries, extras };
}

/** The `size` chefs with the most league budget left (ties: lower index first). */
export function pickLineup(budgets: readonly Budget[], size = 3): number[] {
  return budgets
    .map((b, i) => ({ i, n: b.leagueEntries }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, size)
    .map((x) => x.i)
    .sort((a, b) => a - b);
}

/** How many ranked league rounds the chefs can still afford today, seating the richest three each time. */
export function affordableRounds(budgets: readonly Budget[], size = 3): number {
  const left = budgets.map((b) => b.leagueEntries);
  let rounds = 0;
  for (;;) {
    const seats = left.map((n, i) => ({ n, i })).sort((a, b) => b.n - a.n).slice(0, size);
    if (seats.length < size || seats.some((s) => s.n <= 0)) return rounds;
    for (const s of seats) left[s.i]--;
    rounds++;
  }
}

/**
 * Whether this league round should be ranked. The rounds the chefs can still afford are spread
 * evenly over what's left of the UTC day: a ranked round is due once the gap since the last one
 * reaches (time left in the day) / (rounds affordable).
 */
export function rankedDue(nowMs: number, lastRankedMs: number, rounds: number): boolean {
  if (rounds <= 0) return false;
  const dayEnd = (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
  const spacing = (dayEnd - nowMs) / rounds;
  // a new day (or never ranked) is always due
  if (Math.floor(lastRankedMs / DAY_MS) !== Math.floor(nowMs / DAY_MS)) return true;
  return nowMs - lastRankedMs >= spacing;
}
