import { CARD_INFO, CARDS, type Card } from './content.ts';

// The Fixer's prices. Rules decide every number; the language model only voices the haggling.
// Price = base x demand, where demand rises with each sale in the last hour and decays back.

export const BASE_PRICE: Record<Card, number> = Object.fromEntries(
  CARDS.map((c) => [c, CARD_INFO[c].cost * 12]),
) as Record<Card, number>;

export const DEMAND_STEP = 0.15;
export const DEMAND_CAP = 3;
export const HAGGLE_FLOOR = 0.8; // never below 80% of list
export const WINDOW_MS = 60 * 60 * 1000;

/** List price given the timestamps (ms) of recent sales of this card. */
export function listPrice(card: Card, recentSales: readonly number[], now: number): number {
  const recent = recentSales.filter((t) => now - t < WINDOW_MS && t <= now);
  // each sale's weight fades linearly over the window
  const weight = recent.reduce((a, t) => a + (1 - (now - t) / WINDOW_MS), 0);
  const mult = Math.min(DEMAND_CAP, 1 + DEMAND_STEP * weight);
  return Math.max(1, Math.round(BASE_PRICE[card] * mult));
}

export type HaggleOutcome =
  | { kind: 'accept'; price: number }
  | { kind: 'counter'; price: number }
  | { kind: 'refuse'; price: number };

/**
 * One haggle round. The Fixer accepts any offer at or above list, counters once at the midpoint
 * (never under the floor), and refuses a second lowball.
 */
export function haggle(list: number, offer: number, round: 0 | 1): HaggleOutcome {
  const floor = Math.ceil(list * HAGGLE_FLOOR);
  if (!Number.isFinite(offer) || offer <= 0) return { kind: 'refuse', price: list };
  if (offer >= list) return { kind: 'accept', price: list };
  if (round === 1) return offer >= floor ? { kind: 'accept', price: Math.round(offer) } : { kind: 'refuse', price: list };
  return { kind: 'counter', price: Math.max(floor, Math.round((list + offer) / 2)) };
}

/** Price of a scouting report on a rival (paying for data). Flat, cheap, and the same for agents and humans. */
export const SCOUT_PRICE = 5;
