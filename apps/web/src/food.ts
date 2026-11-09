import * as THREE from 'three';
import { BASES, type Item, type ItemKind } from '@sushi/rules';

// Procedural, toy-like food. Every item is built from primitives and cached per kind.

const M = (color: number, rough = 0.55, emissive = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive });

const C = {
  rice: M(0xf6f3ea, 0.8), sack: M(0xc9a66b, 0.9), bowl: M(0x2b2e4a, 0.4), burnt: M(0x1b1612, 0.9),
  nori: M(0x1f3b26, 0.6), salmon: M(0xff8a5c, 0.45), salmonSeared: M(0xd96b3a, 0.5), fishSkin: M(0x9fb3c8, 0.4),
  lobster: M(0xd8342a, 0.45), lobsterMeat: M(0xfff0e6, 0.5), lobsterSeared: M(0xe86f4a, 0.5),
  tomato: M(0xe2322b, 0.35), tomatoBlister: M(0xa8231b, 0.5), stem: M(0x3b7a2a),
  avocado: M(0x3f6b2a, 0.5), avoFlesh: M(0xc8e07a, 0.6), pit: M(0x7a4a25),
  wasabi: M(0x7fbf4d, 0.6), wasabiPaste: M(0x9be05a, 0.4), chutney: M(0x5d9a3a, 0.3),
  plate: M(0xf7f7f4, 0.2), rim: M(0x2b4a7a, 0.3),
};

const geo = {
  sphere: new THREE.SphereGeometry(1, 20, 14),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 24),
  cone: new THREE.ConeGeometry(1, 1, 20),
  bowl: new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
};

function mesh(g: THREE.BufferGeometry, m: THREE.Material, s: [number, number, number], p: [number, number, number] = [0, 0, 0], r: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.scale.set(...s); o.position.set(...p); o.rotation.set(...r);
  o.castShadow = true;
  return o;
}

function slices(m: THREE.Material, n = 3, w = 0.16, h = 0.04, d = 0.1): THREE.Group {
  const g = new THREE.Group();
  for (let k = 0; k < n; k++) g.add(mesh(geo.box, m, [w, h, d], [(k - (n - 1) / 2) * (w * 0.8), h / 2 + k * 0.012, 0], [0, 0.3 * (k - 1), 0.15]));
  return g;
}

function bowlOf(fill: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(geo.bowl, C.bowl, [0.17, 0.12, 0.17], [0, 0.12, 0], [Math.PI, 0, 0]));
  g.add(mesh(geo.sphere, fill, [0.15, 0.06, 0.15], [0, 0.12, 0]));
  return g;
}

const BUILD: Record<ItemKind, () => THREE.Object3D> = {
  rice_raw: () => { const g = new THREE.Group(); g.add(mesh(geo.sphere, C.sack, [0.16, 0.18, 0.13], [0, 0.17, 0])); g.add(mesh(geo.cyl, C.sack, [0.06, 0.06, 0.06], [0, 0.36, 0])); return g; },
  rice_cooked: () => bowlOf(C.rice),
  rice_burnt: () => bowlOf(C.burnt),
  sushi_rice: () => mesh(geo.box, C.rice, [0.26, 0.1, 0.18], [0, 0.05, 0]),
  nori_sheet: () => mesh(geo.box, C.nori, [0.3, 0.015, 0.24], [0, 0.01, 0]),
  nori_roll: () => { const g = new THREE.Group(); g.add(mesh(geo.cyl, C.nori, [0.09, 0.3, 0.09], [0, 0.09, 0], [0, 0, Math.PI / 2])); g.add(mesh(geo.cyl, C.rice, [0.075, 0.302, 0.075], [0, 0.09, 0], [0, 0, Math.PI / 2])); return g; },
  nori_cone: () => mesh(geo.cone, C.nori, [0.1, 0.3, 0.1], [0, 0.15, 0], [Math.PI, 0, 0]),
  fish: () => { const g = new THREE.Group(); g.add(mesh(geo.sphere, C.fishSkin, [0.2, 0.08, 0.09], [0, 0.08, 0])); g.add(mesh(geo.cone, C.fishSkin, [0.07, 0.1, 0.03], [-0.24, 0.08, 0], [0, 0, Math.PI / 2])); return g; },
  fish_sliced: () => slices(C.salmon),
  fish_seared: () => slices(C.salmonSeared),
  fish_burnt: () => slices(C.burnt),
  lobster: () => { const g = new THREE.Group(); g.add(mesh(geo.sphere, C.lobster, [0.2, 0.08, 0.09], [0, 0.08, 0])); for (const z of [-0.08, 0.08]) g.add(mesh(geo.sphere, C.lobster, [0.06, 0.05, 0.05], [0.22, 0.08, z])); return g; },
  lobster_sliced: () => slices(C.lobsterMeat),
  lobster_seared: () => slices(C.lobsterSeared),
  lobster_burnt: () => slices(C.burnt),
  tomato: () => { const g = new THREE.Group(); g.add(mesh(geo.sphere, C.tomato, [0.13, 0.11, 0.13], [0, 0.11, 0])); g.add(mesh(geo.cyl, C.stem, [0.02, 0.04, 0.02], [0, 0.23, 0])); return g; },
  tomato_sliced: () => slices(C.tomato, 3, 0.12, 0.03, 0.12),
  tomato_blistered: () => slices(C.tomatoBlister, 3, 0.12, 0.03, 0.12),
  avocado: () => mesh(geo.sphere, C.avocado, [0.1, 0.14, 0.1], [0, 0.14, 0]),
  avocado_diced: () => { const g = new THREE.Group(); for (let k = 0; k < 6; k++) g.add(mesh(geo.box, C.avoFlesh, [0.06, 0.06, 0.06], [((k % 3) - 1) * 0.07, 0.03 + Math.floor(k / 3) * 0.05, (k % 2) * 0.05 - 0.02])); return g; },
  wasabi: () => { const g = new THREE.Group(); g.add(mesh(geo.cyl, C.wasabi, [0.05, 0.22, 0.05], [0, 0.11, 0])); g.add(mesh(geo.sphere, C.stem, [0.08, 0.06, 0.08], [0, 0.25, 0])); return g; },
  wasabi_sliced: () => slices(C.wasabiPaste, 4, 0.06, 0.02, 0.06),
  wasabi_chutney: () => bowlOf(C.chutney),
  plate: () => mesh(geo.cyl, C.plate, [0.28, 0.03, 0.28], [0, 0.015, 0]),
};

const cache = new Map<string, THREE.Object3D>();
const keyOf = (it: Item): string => (it.k === 'plate' ? `plate:${[...(it.on ?? [])].sort().join(',')}` : it.k);

/** A finished-looking dish: maki pieces or a temaki cone with the fillings showing. */
function dish(on: readonly ItemKind[]): THREE.Group {
  const g = new THREE.Group();
  const fills = on.filter((k) => !BASES.has(k) && k !== 'sushi_rice');
  const fillMat = (k: ItemKind): THREE.Material => (({ fish_seared: C.salmonSeared, lobster_seared: C.lobsterSeared, tomato_blistered: C.tomatoBlister, avocado_diced: C.avoFlesh, wasabi_sliced: C.wasabiPaste, wasabi_chutney: C.chutney } as Partial<Record<ItemKind, THREE.Material>>)[k] ?? C.rice);
  if (on.includes('nori_roll')) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const p = new THREE.Group();
      p.add(mesh(geo.cyl, C.nori, [0.075, 0.07, 0.075], [0, 0.035, 0]));
      if (on.includes('sushi_rice')) p.add(mesh(geo.cyl, C.rice, [0.062, 0.072, 0.062], [0, 0.036, 0]));
      fills.forEach((f, j) => p.add(mesh(geo.cyl, fillMat(f), [0.022, 0.074, 0.022], [Math.cos(j * 2.1) * 0.025, 0.037, Math.sin(j * 2.1) * 0.025])));
      p.position.set(Math.cos(a) * 0.13, 0.03, Math.sin(a) * 0.13);
      g.add(p);
    }
  } else if (on.includes('nori_cone')) {
    const cone = mesh(geo.cone, C.nori, [0.1, 0.3, 0.1], [0, 0.14, 0], [Math.PI * 0.75, 0, 0]);
    g.add(cone);
    if (on.includes('sushi_rice')) g.add(mesh(geo.sphere, C.rice, [0.08, 0.05, 0.08], [0, 0.2, 0.08]));
    fills.forEach((f, j) => g.add(mesh(geo.sphere, fillMat(f), [0.04, 0.04, 0.04], [(j - fills.length / 2) * 0.05, 0.25, 0.1])));
  } else {
    on.forEach((k, j) => {
      const o = BUILD[k]().clone();
      o.scale.multiplyScalar(0.55);
      const a = (j / Math.max(1, on.length)) * Math.PI * 2;
      o.position.set(Math.cos(a) * 0.11, 0.03, Math.sin(a) * 0.11);
      g.add(o);
    });
  }
  return g;
}

export function itemObject(it: Item): THREE.Object3D {
  const key = keyOf(it);
  let proto = cache.get(key);
  if (!proto) {
    if (it.k === 'plate') {
      const g = new THREE.Group();
      g.add(BUILD.plate());
      g.add(mesh(new THREE.TorusGeometry(0.27, 0.012, 6, 32), C.rim, [1, 1, 1], [0, 0.03, 0], [Math.PI / 2, 0, 0]));
      if (it.on?.length) { const d = dish(it.on); d.position.y = 0.03; g.add(d); }
      proto = g;
    } else proto = BUILD[it.k]();
    cache.set(key, proto);
  }
  // always a wrapper group, so callers can position/scale it without touching the item's own transform
  const g = new THREE.Group();
  g.add(proto.clone());
  return g;
}

export { keyOf };

/** CSS colour for an ingredient chip in the UI. */
export const CHIP: Record<string, string> = {
  sushi_rice: '#f6f3ea', nori_roll: '#1f3b26', nori_cone: '#2f5a36', fish_seared: '#ff8a5c', lobster_seared: '#e8402e',
  tomato_blistered: '#c9302a', avocado_diced: '#b5d36a', wasabi_sliced: '#9be05a', wasabi_chutney: '#5d9a3a',
};
export const CHIP_LABEL: Record<string, string> = {
  sushi_rice: 'rice', nori_roll: 'roll', nori_cone: 'cone', fish_seared: 'fish', lobster_seared: 'lobster',
  tomato_blistered: 'tomato', avocado_diced: 'avocado', wasabi_sliced: 'wasabi', wasabi_chutney: 'chutney',
};
