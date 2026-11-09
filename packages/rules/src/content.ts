// Every item, recipe, station transform and sabotage card. Pure data.
// Recipe names and ingredient chains follow our earlier game Sushi Bonks.

export const TICK_HZ = 20;
export const secs = (s: number): number => Math.round(s * TICK_HZ);

export const ITEM_KINDS = [
  'rice_raw', 'rice_cooked', 'rice_burnt', 'sushi_rice',
  'nori_sheet', 'nori_roll', 'nori_cone',
  'fish', 'fish_sliced', 'fish_seared', 'fish_burnt',
  'lobster', 'lobster_sliced', 'lobster_seared', 'lobster_burnt',
  'tomato', 'tomato_sliced', 'tomato_blistered',
  'avocado', 'avocado_diced',
  'wasabi', 'wasabi_sliced', 'wasabi_chutney',
  'plate',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_LABEL: Record<ItemKind, string> = {
  rice_raw: 'Raw rice', rice_cooked: 'Cooked rice', rice_burnt: 'Burnt rice', sushi_rice: 'Sushi rice',
  nori_sheet: 'Nori sheet', nori_roll: 'Nori roll', nori_cone: 'Nori cone',
  fish: 'Fish', fish_sliced: 'Sliced fish', fish_seared: 'Seared fish', fish_burnt: 'Burnt fish',
  lobster: 'Lobster', lobster_sliced: 'Sliced lobster', lobster_seared: 'Seared lobster', lobster_burnt: 'Burnt lobster',
  tomato: 'Tomato', tomato_sliced: 'Sliced tomato', tomato_blistered: 'Blistered tomato',
  avocado: 'Avocado', avocado_diced: 'Diced avocado',
  wasabi: 'Wasabi', wasabi_sliced: 'Wasabi slices', wasabi_chutney: 'Wasabi chutney',
  plate: 'Plate',
};

/** What can go on a plate. Each kind at most once; at most one base and one protein. */
export const PLATEABLE: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'sushi_rice', 'nori_roll', 'nori_cone', 'fish_seared', 'lobster_seared',
  'tomato_blistered', 'avocado_diced', 'wasabi_sliced', 'wasabi_chutney',
]);
export const BASES: ReadonlySet<ItemKind> = new Set<ItemKind>(['nori_roll', 'nori_cone']);
export const PROTEINS: ReadonlySet<ItemKind> = new Set<ItemKind>(['fish_seared', 'lobster_seared']);
export const BURNT: ReadonlySet<ItemKind> = new Set<ItemKind>(['rice_burnt', 'fish_burnt', 'lobster_burnt']);

/** Cutting board: input -> output after `chops` presses. */
export const CUTS: Partial<Record<ItemKind, { out: ItemKind; chops: number }>> = {
  rice_cooked: { out: 'sushi_rice', chops: 3 },
  nori_sheet: { out: 'nori_roll', chops: 3 },
  fish: { out: 'fish_sliced', chops: 3 },
  lobster: { out: 'lobster_sliced', chops: 3 },
  tomato: { out: 'tomato_sliced', chops: 3 },
  avocado: { out: 'avocado_diced', chops: 5 },
  wasabi: { out: 'wasabi_sliced', chops: 3 },
};

export type HeatStation = 'cooker' | 'pan' | 'pot';
export interface Cook { out: ItemKind; ticks: number; burnsTo?: ItemKind; burnTicks?: number }

/** Heat stations: input -> output after `ticks`; output burns after `burnTicks` more if it can. */
export const COOKS: Record<HeatStation, Partial<Record<ItemKind, Cook>>> = {
  cooker: { rice_raw: { out: 'rice_cooked', ticks: secs(3), burnsTo: 'rice_burnt', burnTicks: secs(5) } },
  pan: {
    fish_sliced: { out: 'fish_seared', ticks: secs(3), burnsTo: 'fish_burnt', burnTicks: secs(5) },
    lobster_sliced: { out: 'lobster_seared', ticks: secs(3), burnsTo: 'lobster_burnt', burnTicks: secs(5) },
    tomato_sliced: { out: 'tomato_blistered', ticks: secs(3) },
  },
  pot: { wasabi_sliced: { out: 'wasabi_chutney', ticks: secs(10) } },
};

/** Burn timers keyed by the cooked product, so a station knows how long a finished item has. */
export const BURNS: Partial<Record<ItemKind, { to: ItemKind; ticks: number }>> = {};
for (const table of Object.values(COOKS)) {
  for (const c of Object.values(table)) {
    if (c && c.burnsTo && c.burnTicks) BURNS[c.out] = { to: c.burnsTo, ticks: c.burnTicks };
  }
}

// ---- recipes: 2 bases x 2 proteins x 5 depths = 20 ----

export const EXTRAS: readonly ItemKind[] = ['tomato_blistered', 'avocado_diced', 'wasabi_sliced', 'wasabi_chutney'];

const NAMES: Record<string, string[]> = {
  'maki-fish': ['Azure Fin Maki', 'Sun-Fin Maki', 'Coral Drift Maki', 'Wasabi Wave Maki', 'Aurora Mist Maki'],
  'maki-lobster': ['Crimson Claw Maki', 'Scarlet Tide Maki', 'Emerald Reef Maki', 'Volcanic Reef Maki', 'Inferno Claw Maki'],
  'temaki-fish': ['Blue Current', 'Solar Breeze', 'Verdant Drift', 'Wasabi Gale', 'Celestial Mist'],
  'temaki-lobster': ['Ruby Current', 'Crimson Breeze', 'Emerald Drift', 'Typhoon Claw', 'Solar Flare'],
};

export interface Recipe {
  id: number;
  name: string;
  style: 'maki' | 'temaki';
  protein: 'fish' | 'lobster';
  depth: number; // 0..4 extras
  ingredients: ItemKind[];
}

export const RECIPES: Recipe[] = [];
for (const style of ['maki', 'temaki'] as const) {
  for (const protein of ['fish', 'lobster'] as const) {
    for (let depth = 0; depth <= 4; depth++) {
      RECIPES.push({
        id: RECIPES.length,
        name: NAMES[`${style}-${protein}`][depth],
        style,
        protein,
        depth,
        ingredients: [
          'sushi_rice',
          style === 'maki' ? 'nori_roll' : 'nori_cone',
          protein === 'fish' ? 'fish_seared' : 'lobster_seared',
          ...EXTRAS.slice(0, depth),
        ],
      });
    }
  }
}

/** The recipe whose ingredient set is exactly `contents`, if any. */
export function recipeFor(contents: readonly ItemKind[]): Recipe | undefined {
  return RECIPES.find(
    (r) => r.ingredients.length === contents.length && r.ingredients.every((i) => contents.includes(i)),
  );
}

// ---- sabotage ----

export const CARDS = ['wasabi_bomb', 'fish_swap', 'dull_knife', 'soy_slick', 'order_shuffle', 'bamboo_shield'] as const;
export type Card = (typeof CARDS)[number];

export const CARD_INFO: Record<Card, { name: string; cost: number; self: boolean; blurb: string }> = {
  wasabi_bomb: { name: 'Wasabi Bomb', cost: 2, self: false, blurb: 'Their pan or cooker jumps to about-to-burn.' },
  fish_swap: { name: 'Fish Swap', cost: 2, self: false, blurb: 'Swaps fish and lobster on their plate in progress.' },
  dull_knife: { name: 'Dull Knife', cost: 1, self: false, blurb: 'Their boards need 2 extra chops for 10 s.' },
  soy_slick: { name: 'Soy Slick', cost: 1, self: false, blurb: 'Their chef slides at 60% speed for 6 s.' },
  order_shuffle: { name: 'Order Shuffle', cost: 1, self: false, blurb: 'Their oldest order loses 15 s of patience.' },
  bamboo_shield: { name: 'Bamboo Shield', cost: 1, self: true, blurb: 'Blocks the next sabotage aimed at you.' },
};

export const MISCHIEF_MAX = 5;
export const CARD_COOLDOWN = secs(3);
export const DULL_TICKS = secs(10);
export const DULL_EXTRA_CHOPS = 2;
export const SLICK_TICKS = secs(6);
export const SLICK_SPEED = 0.6;
export const SHUFFLE_TICKS = secs(15);
export const BOMB_LEFT = secs(1.5);

// ---- shift ----

export const SHIFT_TICKS = secs(180);
export const ORDER_EVERY = secs(12);
export const ORDERS_MAX = 4;
export const PLATE_EVERY = secs(4);
export const PLATES_MAX = 4;
export const MOVE_SPEED = 4.2; // cells per second
export const CHEF_RADIUS = 0.32;

/** Patience for an order of `size` ingredients (3..7). */
export const patienceFor = (size: number): number => secs(55 + 10 * (size - 3));

// ---- scoring ----

export const SCORE = {
  perIngredient: 8,
  base: 20,
  maxTipFraction: 0.5,
  burn: -10,
  trash: -5,
  wrongDish: -5,
  expired: -15,
  accuseRight: 40,
  caught: -40,
  accuseWrong: -10,
  streak: [
    { at: 8, mult: 1.5 },
    { at: 5, mult: 1.25 },
    { at: 3, mult: 1.1 },
  ],
};
