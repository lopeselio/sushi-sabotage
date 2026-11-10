import { secs } from './content.ts';
import { newMind, sloppyCard, sloppyMove, type Mind, type Profile } from './bot2.ts';
import { seedFrom, type Rng } from './rng.ts';
import type { Input, State } from './sim.ts';

// A "reference human" for balance runs: a deliberately average player, not a bot seat.
// It plays through the same inputs a browser sends (it is never a sim bot), so it measures what a
// person at a keyboard can do against the AI chefs. It knows what to cook (it borrows the bots'
// planner, like the tutorial hints do) but it is slow and sloppy:
//  - ~300 ms between actions (6 ticks + 0..3), and two seconds to read the first order;
//  - mashes F about 5 times a second;
//  - one trip in five takes a longer route (a detour via a random spot on the floor);
//  - forgets about one pan/cooker load in seven until it burns, and grabs the wrong crate now and then;
//  - plays a sabotage card about twice a minute when it has the mischief, at the leader 60% of the time.
// Deterministic (its own seeded RNG), so balance numbers are reproducible. Not used in matches.

export const REF_HUMAN: Profile = {
  reaction: 6, jitter: 3, chopEvery: 4, startDelay: secs(2), stride: 1, detour: 0.2, forget: 0.15, fumble: 0.03,
  dazed: secs(1), cardsPerMin: 2, firstCard: secs(10), focus: 0.6, shield: 0.3,
};

export interface RefHuman { p: Profile; rng: Rng; mind: Mind }

export const newRefHuman = (seed: string, p: Profile = REF_HUMAN): RefHuman => ({ p, rng: { s: seedFrom(`human:${seed}`) }, mind: newMind(p) });

/** One tick of the reference human's input for chef i (sent as a human's input, never as a bot). */
export function refHumanInput(s: State, i: number, h: RefHuman): Input {
  return { ...sloppyMove(s, i, h.mind, h.p, h.rng), ...sloppyCard(s, i, h.mind, h.p, h.rng) };
}
