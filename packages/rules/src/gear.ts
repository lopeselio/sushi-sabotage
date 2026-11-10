// Chef upgrades (rules v3). Bought with testnet NEAR on the Chef NFT (contracts/kitchen, buy_upgrade).
// The referee puts a chef's levels into the match setup and the contract checks and records them at
// create_match, so the replay and `pnpm verify` see exactly what was played with.
//
// Every effect is small and capped, and ranked shifts count at most RANKED_GEAR_CAP levels per slot,
// so a fully upgraded chef is a little smoother, not unbeatable (DESIGN.md, "Chef upgrades").
// All maths is integer ticks or a fixed multiplier, so the sim stays deterministic.

export const GEAR = ['knife', 'pan', 'sandals', 'apron'] as const;
export type GearSlot = (typeof GEAR)[number];
export type Gear = Partial<Record<GearSlot, number>>;

export const GEAR_MAX = 5;
/** In a ranked shift each slot counts up to this level. */
export const RANKED_GEAR_CAP = 3;

export const GEAR_INFO: Record<GearSlot, { name: string; blurb: string; per: (level: number) => string }> = {
  knife: { name: 'Knife', blurb: 'Some chops cut twice.', per: (l) => `${8 * l}% of chops cut twice` },
  pan: { name: 'Pan', blurb: 'Cooked food on the pan or cooker takes longer to burn.', per: (l) => `+${6 * l}% before it burns` },
  sandals: { name: 'Sandals', blurb: 'Walk a little faster.', per: (l) => `+${2 * l}% walking speed` },
  apron: { name: 'Apron', blurb: 'Shrugs off sabotage: Dull Knife and Soy Slick wear off sooner, Order Shuffle costs less patience.', per: (l) => `−${6 * l}% sabotage effect` },
};

/** A level 0..GEAR_MAX for a slot (anything else is refused). */
export function gearLevel(g: Gear | undefined, slot: GearSlot): number {
  return g?.[slot] ?? 0;
}

/** Checks a setup's gear: known slots, integer levels in range, at most `cap`. Returns it without zero slots. */
export function cleanGear(g: Gear, cap = GEAR_MAX): Gear {
  const out: Gear = {};
  for (const [k, v] of Object.entries(g)) {
    if (!GEAR.includes(k as GearSlot)) throw new Error(`unknown gear slot ${k}`);
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > cap) throw new Error(`gear ${k} must be 0..${cap}`);
    if (v) out[k as GearSlot] = v;
  }
  return out;
}

/** Gear as the contract stores it: one level per slot, in GEAR order. */
export const gearToArray = (g: Gear | undefined): number[] => GEAR.map((k) => gearLevel(g, k));
export const gearFromArray = (a: readonly number[] | undefined): Gear => {
  const g: Gear = {};
  GEAR.forEach((k, i) => { if (a?.[i]) g[k] = a[i]; });
  return g;
};

/** Knife level L: a chop has an L × 8 % chance to count twice (40 % at L5). The roll is a hash of
 *  (seed, chef, chop number), so it's the same on every replay and no other random draw moves. */
export const knifeChance = (level: number): number => 0.08 * level;

/** Pan level L: a cooked item's burn window is L × 6 % longer (5 s → 6.5 s at L5). */
export const burnWindow = (ticks: number, level: number): number => (level ? Math.floor((ticks * (100 + 6 * level)) / 100) : ticks);

/** Sandals level L: L × 2 % faster walking (callers skip the multiply at L0, so v1/v2 maths is untouched). */
export const walkMult = (level: number): number => 1 + 0.02 * level;

/** Apron level L: Dull Knife and Soy Slick last L × 6 % less, Order Shuffle takes L × 6 % less patience. */
export const apronTicks = (ticks: number, level: number): number => (level ? Math.floor((ticks * (100 - 6 * level)) / 100) : ticks);
