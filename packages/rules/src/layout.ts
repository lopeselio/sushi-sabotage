import type { ItemKind } from './content.ts';

// One chef's pod: a 9x7 grid of 1x1 cells. Cell (x, z) covers [x, x+1] x [z, z+1].
// Every chef gets an identical pod; pods are separate, so chefs only touch rivals through cards.

export type CounterType = 'clear' | 'container' | 'board' | 'cooker' | 'pan' | 'pot' | 'plates' | 'delivery' | 'trash';

export interface Counter {
  idx: number;
  x: number;
  z: number;
  type: CounterType;
  source?: ItemKind;
}

const MAP = [
  '#rnoKPWX#',
  'f       P',
  'l       #',
  't  B#B  #',
  'a       #',
  'w       S',
  '####D####',
];

const LEGEND: Record<string, { type: CounterType; source?: ItemKind }> = {
  r: { type: 'container', source: 'rice_raw' },
  n: { type: 'container', source: 'nori_sheet' },
  o: { type: 'container', source: 'nori_cone' },
  f: { type: 'container', source: 'fish' },
  l: { type: 'container', source: 'lobster' },
  t: { type: 'container', source: 'tomato' },
  a: { type: 'container', source: 'avocado' },
  w: { type: 'container', source: 'wasabi' },
  '#': { type: 'clear' },
  K: { type: 'cooker' },
  P: { type: 'pan' },
  W: { type: 'pot' },
  X: { type: 'trash' },
  B: { type: 'board' },
  S: { type: 'plates' },
  D: { type: 'delivery' },
};

export const POD_W = MAP[0].length;
export const POD_H = MAP.length;
export const SPAWN = { x: 4.5, z: 4.5 };

export const COUNTERS: Counter[] = [];
const grid: (number | -1)[] = new Array(POD_W * POD_H).fill(-1);
for (let z = 0; z < POD_H; z++) {
  for (let x = 0; x < POD_W; x++) {
    const ch = MAP[z][x];
    if (ch === ' ') continue;
    const def = LEGEND[ch];
    if (!def) throw new Error(`layout: unknown cell '${ch}'`);
    grid[z * POD_W + x] = COUNTERS.length;
    COUNTERS.push({ idx: COUNTERS.length, x, z, ...def });
  }
}

/** Counter index at a cell, -1 for floor; out-of-bounds counts as wall (-2). */
export function counterAt(x: number, z: number): number {
  if (x < 0 || z < 0 || x >= POD_W || z >= POD_H) return -2;
  return grid[z * POD_W + x];
}
export const isBlocked = (x: number, z: number): boolean => counterAt(x, z) !== -1;
export const countersOfType = (t: CounterType): Counter[] => COUNTERS.filter((c) => c.type === t);
export const containerFor = (k: ItemKind): Counter | undefined => COUNTERS.find((c) => c.source === k);
export const isHeat = (t: CounterType): t is 'cooker' | 'pan' | 'pot' => t === 'cooker' || t === 'pan' || t === 'pot';
