import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BURNS, COOKS, COUNTERS, POD_H, POD_W, facingCounter, isHeat, stationProgress, type Card, type Chef, type Counter, type SimEvent, type State } from '@sushi/rules';
import { itemObject, keyOf, setFoodModels } from './food.ts';
import { Particles, Pops, blobTexture, floorTexture, signTexture, streetTextures } from './fx.ts';

// The night-market kitchen. Pods are laid out 2x2 on a wet stone street; the camera follows yours.
// Static geometry of each stall (counters, walls, dressing) is merged per material, so a pod costs a few
// dozen draw calls; only parts that animate stay separate.

export const CHEF_COLORS = [0xe2433b, 0x2f8fe0, 0xf2b134, 0x8e5bd8];
const GAP_X = 3.2, GAP_Z = 4.2;
export const podOrigin = (i: number): THREE.Vector3 => new THREE.Vector3((i % 2) * (POD_W + GAP_X), 0, Math.floor(i / 2) * (POD_H + GAP_Z));

const MODEL_FOR: Record<Counter['type'], string> = {
  clear: 'counter', container: 'container', board: 'board', cooker: 'cooker', pan: 'pan', pot: 'pot', plates: 'plates', delivery: 'delivery', trash: 'trash',
};

/** Which way a counter's front faces (toward the floor), as a rotation about Y. */
function counterYaw(c: Counter): number {
  if (c.z === 0) return 0;
  if (c.z === POD_H - 1) return Math.PI;
  if (c.x === 0) return Math.PI / 2;
  if (c.x === POD_W - 1) return -Math.PI / 2;
  return 0;
}

interface Slot { key: string; obj: THREE.Object3D | null; bar: THREE.Group; fill: THREE.Mesh; pop: number; baseY: number }
/** Named parts of a station model that animate (from the Blender object names). */
interface Prop { root: THREE.Object3D; parts: Record<string, THREE.Object3D>; rest: Record<string, { p: THREE.Vector3; r: THREE.Euler }>; t: number }
interface Limb { o: THREE.Object3D; p: THREE.Vector3 }
interface ChefView {
  root: THREE.Object3D; body: THREE.Object3D; heldKey: string; held: THREE.Object3D | null; label: THREE.Sprite; blob: THREE.Mesh;
  px: number; pz: number; bob: number; t: number; chop: number; reach: number; carry: number; hit: number; cheer: number;
  limbs: Partial<Record<'handL' | 'handR' | 'footL' | 'footR', Limb>>;
  slick: THREE.Mesh; shield: THREE.Mesh;
}
interface PodView {
  group: THREE.Group; origin: THREE.Vector3; slots: Slot[]; props: Prop[]; chef: ChefView; plates: THREE.Object3D[];
  flash: THREE.Mesh; flashT: number; flashColor: number; select: THREE.Mesh; containerIcons: (THREE.Object3D | null)[];
  lanterns: THREE.Object3D[]; lamp: THREE.PointLight; lampBoost: number; emit: Float32Array;
}

const ANIMATED = new Set(['blade', 'handle', 'pan', 'flame', 'broth', 'lid', 'knob', 'bell', 'crate', 'plate0', 'plate1', 'plate2']);
/** A springy 0→1 pop curve for squash and stretch: overshoots, then settles. */
const popScale = (t: number): number => (t >= 1 ? 1 : 1 + Math.sin(t * Math.PI * 2.5) * 0.35 * (1 - t));
const params = new URLSearchParams(location.search);
const CHIP_COLOR: Partial<Record<string, number>> = {
  fish: 0xff8a5c, lobster: 0xfff0e6, tomato: 0xe2322b, avocado: 0xb5d36a, wasabi: 0x9be05a, rice: 0xf6f3ea,
};
const BULB_COLORS = [0xffc46b, 0xff7a4a, 0xffe9b0, 0xff5470];
const HANDS = [['handL', 1], ['handR', -1]] as const;
const DELIVERY = COUNTERS.findIndex((c) => c.type === 'delivery');
const PAN = COUNTERS.find((c) => c.type === 'pan')!;

export class KitchenScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private composer: EffectComposer;
  private bloomOn: boolean;
  private pixelRatio: number;
  private models = new Map<string, THREE.Object3D>();
  private pods: PodView[] = [];
  private last: State | null = null;
  private smoke = new Particles(1400, false);
  private glow = new Particles(900, true, true);
  private chips = new Particles(500, false, true);
  private pops = new Pops(8);
  private blobTex = blobTexture();
  private floorTex = floorTexture();
  private street = new THREE.Group();
  private vents: THREE.Vector3[] = [];
  private ventAcc = 0;
  private moon!: THREE.DirectionalLight;
  private stove!: THREE.PointLight;
  private stoveHeat = 0;
  private hint: THREE.Mesh;
  private hintCounter = -1;
  private hintT = 0;
  private clock = 0;
  private shake = 0;
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private perf = { last: 0, acc: 0, n: 0, strikes: 0, warm: 0 };
  overview = false;
  you = 0;
  /** your own chef's predicted position (multiplayer), overrides the snapshot */
  predicted: { x: number; z: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    // quality: touch devices, small screens and ?fx=low start without bloom at a lower pixel ratio; ?fx=high forces bloom on
    const fx = params.get('fx');
    const low = fx === 'low' || (fx !== 'high' && (matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600));
    this.bloomOn = !low && params.get('bloom') !== '0';
    this.pixelRatio = Math.min(low ? 1.25 : 1.75, window.devicePixelRatio || 1);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x0e0a18);
    this.scene.fog = new THREE.Fog(0x0e0a18, 24, 62);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.82));
    this.composer.addPass(new OutputPass());
    this.environment();
    this.lights();
    this.scene.add(this.smoke.points, this.chips.points, this.glow.points, this.pops.group, this.street);
    this.hint = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 20), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffa000, emissiveIntensity: 0.5, roughness: 0.4 }));
    this.hint.rotation.x = Math.PI;
    this.hint.visible = false;
    this.scene.add(this.hint);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const names = ['chef', 'counter', 'board', 'cooker', 'pan', 'pot', 'plates', 'delivery', 'trash', 'container', 'lantern', 'noren', 'dressing', 'food'];
    await Promise.all(names.map(async (n) => {
      const g = await loader.loadAsync(`/models/${n}.glb`);
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // glowing bits (lantern paper, flames, lit signs) neither cast nor receive shadows
        const mat = m.material as THREE.MeshStandardMaterial;
        const glows = !!mat.emissive && mat.emissive.getHex() !== 0 && mat.emissiveIntensity > 0;
        m.castShadow = !glows;
        m.receiveShadow = !glows;
      });
      this.models.set(n, g.scene);
    }));
    setFoodModels(this.models.get('food')!);
  }

  /** A tiny night sky with warm lantern blobs, prefiltered once: gives metal and the wet street something to reflect. */
  private environment(): void {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x120c22);
    env.add(new THREE.Mesh(new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x221a3a, side: THREE.BackSide })));
    const blob = new THREE.SphereGeometry(1, 8, 6);
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2, e = 0.15 + (k % 3) * 0.12;
      const warm = k % 4 !== 0;
      const m = new THREE.Mesh(blob, new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(warm ? 6 : 4, warm ? 2.6 : 3.4, warm ? 0.9 : 2.0) }));
      m.position.set(Math.cos(a) * 20 * Math.cos(e), 20 * Math.sin(e), Math.sin(a) * 20 * Math.cos(e));
      m.scale.setScalar(0.9 + (k % 2) * 0.6);
      env.add(m);
    }
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(env, 0.03).texture;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();
  }

  private lights(): void {
    this.scene.add(new THREE.HemisphereLight(0x8f86d0, 0x2a1822, 0.85));
    // a warm key from the street so faces and food read clearly
    const key = new THREE.DirectionalLight(0xffcf9a, 0.9);
    key.position.set(4, 10, 14);
    this.scene.add(key);
    // the cool moon casts the shadows; its frustum follows the camera target (see updateCamera)
    this.moon = new THREE.DirectionalLight(0xaab6ff, 1.0);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(2048, 2048);
    this.moon.shadow.radius = 3;
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.02;
    this.moon.shadow.camera.far = 60;
    this.scene.add(this.moon, this.moon.target);
    // one flickering stove light over your own pan, used while it cooks
    this.stove = new THREE.PointLight(0xff7a2a, 0, 4.5, 1.6);
    this.scene.add(this.stove);
    // the wet street
    const { map, rough } = streetTextures();
    map.repeat.set(30, 30);
    rough.repeat.set(30, 30);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0.15, color: 0xcfc6e0 }));
    street.rotation.x = -Math.PI / 2;
    street.position.set(10, -0.01, 9);
    street.receiveShadow = true;
    this.scene.add(street);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = (h * this.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const p of [this.smoke, this.glow, this.chips]) p.setScale(scale);
  }

  private model(n: string): THREE.Object3D {
    return this.models.get(n)!.clone(true);
  }

  private dressing(n: string): THREE.Object3D {
    const g = this.models.get('dressing')!.getObjectByName(n)!.clone(true);
    g.position.set(0, 0, 0);
    return g;
  }

  /** Build the pods for a match. */
  build(names: string[], you: number): void {
    for (const p of this.pods) {
      this.scene.remove(p.group);
      // free what each pod made for itself: merged geometry and the canvas textures of its sign and label
      p.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && o.userData.merged) m.geometry.dispose();
        const mat = (o as unknown as { material?: THREE.Material & { map?: THREE.Texture | null } }).material;
        if (mat && !Array.isArray(mat) && mat.map instanceof THREE.CanvasTexture && mat.map !== this.blobTex && mat.map !== this.floorTex) { mat.map.dispose(); mat.dispose(); }
      });
    }
    this.pods = [];
    this.last = null;
    this.you = you;
    names.forEach((name, i) => this.pods.push(this.buildPod(i, name)));
    this.buildStreet(names.length);
    const o = podOrigin(you);
    this.camTarget.set(o.x + POD_W / 2, 0, o.z + POD_H / 2);
    this.camPos.copy(this.camTarget).add(this.v1.set(0, 11, 8.5));
  }

  /** Steam vents in the street between the stalls. */
  private buildStreet(n: number): void {
    this.street.clear();
    this.vents = [];
    const cols = n > 1 ? 2 : 1, rows = Math.ceil(n / 2);
    const spots: [number, number][] = [[POD_W / 2, POD_H + GAP_Z / 2]];
    if (cols > 1) spots.push([POD_W + GAP_X / 2, POD_H / 2 - 1], [POD_W * 1.5 + GAP_X, POD_H + GAP_Z / 2 + 0.6]);
    if (rows > 1) spots.push([POD_W + GAP_X / 2, POD_H * 1.5 + GAP_Z]);
    for (const [x, z] of spots) {
      const v = this.dressing('vent');
      v.position.set(x, 0, z);
      this.street.add(v);
      this.vents.push(new THREE.Vector3(x, 0.1, z));
    }
  }

  private buildPod(i: number, name: string): PodView {
    const group = new THREE.Group();
    const origin = podOrigin(i);
    group.position.copy(origin);
    this.scene.add(group);
    const color = CHEF_COLORS[i % CHEF_COLORS.length];
    // wooden floor boards; yours is lit a little warmer
    this.floorTex.repeat.set(POD_W / 3, POD_H / 3);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(POD_W, 0.06, POD_H), new THREE.MeshStandardMaterial({ map: this.floorTex, color: i === this.you ? 0xffe2c4 : 0xc9b4a4, roughness: 0.75 }));
    floor.position.set(POD_W / 2, 0.0, POD_H / 2);
    floor.receiveShadow = true;
    group.add(floor);
    const slots: Slot[] = [];
    const props: Prop[] = [];
    const containerIcons: (THREE.Object3D | null)[] = [];
    const statics: THREE.Object3D[] = [];
    for (const c of COUNTERS) {
      const m = this.model(MODEL_FOR[c.type]);
      m.position.set(c.x + 0.5, 0, c.z + 0.5);
      m.rotation.y = counterYaw(c);
      group.add(m);
      statics.push(m);
      const prop: Prop = { root: m, parts: {}, rest: {}, t: 0 };
      for (const n of ANIMATED) {
        const o = m.getObjectByName(n);
        if (o) { prop.parts[n] = o; prop.rest[n] = { p: o.position.clone(), r: o.rotation.clone() }; }
      }
      props.push(prop);
      let icon: THREE.Object3D | null = null;
      if (c.type === 'container' && c.source) {
        icon = itemObject({ k: c.source });
        icon.position.set(c.x + 0.5, 0.97, c.z + 0.5);
        icon.rotation.y = counterYaw(c);
        icon.scale.setScalar(1.1);
        group.add(icon);
      }
      containerIcons.push(icon);
      const bar = new THREE.Group();
      const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.12), new THREE.MeshBasicMaterial({ color: 0x120c18, transparent: true, opacity: 0.8, depthTest: false, toneMapped: false }));
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.07), new THREE.MeshBasicMaterial({ color: 0x5ee06a, depthTest: false, toneMapped: false }));
      fill.position.z = 0.001;
      bg.renderOrder = 10; fill.renderOrder = 11;
      bar.add(bg, fill);
      bar.position.set(c.x + 0.5, 1.8, c.z + 0.5);
      bar.visible = false;
      group.add(bar);
      slots.push({ key: '', obj: null, bar, fill, pop: 1, baseY: 0.92 });
    }
    // the stall: back wall with shoji and a shelf, noren, signboard, corner posts, stools and crates
    const place = (o: THREE.Object3D, x: number, y: number, z: number, yaw = 0): void => { o.position.set(x, y, z); o.rotation.y = yaw; group.add(o); statics.push(o); };
    place(this.dressing('backwall'), POD_W / 2, 0, -0.62);
    place(this.model('noren'), POD_W / 2, 0.85, -0.42);
    place(this.dressing('sign'), POD_W / 2, 3.55, -0.6);
    place(this.dressing('post'), -0.3, 0, POD_H + 0.3);
    place(this.dressing('post'), POD_W + 0.3, 0, POD_H + 0.3, Math.PI);
    for (const x of [POD_W / 2 - 1.3, POD_W / 2 + 1.3]) place(this.dressing('stool'), x, 0, POD_H + 0.75);
    place(this.dressing('crates'), -1.05, 0, 1.4, Math.PI / 2 + 0.2);
    place(this.dressing('barrel'), POD_W + 0.75, 0, 2.2);
    this.mergeStatic(group, statics);
    // the stall's name on its signboard
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.52), new THREE.MeshBasicMaterial({ map: signTexture(name, color), transparent: true, toneMapped: false }));
    sign.position.set(POD_W / 2, 3.55, -0.6 + 0.045);
    group.add(sign);
    // lanterns: two on the front posts, two under the back lintel
    const lanterns: THREE.Object3D[] = [];
    for (const [x, y, z] of [[0.3, 2.05, POD_H + 0.3], [POD_W - 0.3, 2.05, POD_H + 0.3], [1.0, 2.55, -0.25], [POD_W - 1.0, 2.55, -0.25]]) {
      const l = this.model('lantern');
      l.position.set(x, y, z);
      l.traverse((o) => { o.castShadow = false; });
      group.add(l);
      lanterns.push(l);
    }
    this.stringLights(group, i);
    const lamp = new THREE.PointLight(0xffa25a, 14, 15, 1.3);
    lamp.position.set(POD_W / 2, 4.6, POD_H / 2 + 1.0);
    group.add(lamp);
    // chef: materials named Tint* take the player's colour (TintDark a shade darker)
    const body = this.model('chef');
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.isMesh ? (mesh.material as THREE.MeshStandardMaterial) : null;
      if (mat && mat.name.startsWith('Tint')) {
        const m = mat.clone();
        m.color.setHex(color);
        if (mat.name.includes('Dark')) m.color.multiplyScalar(0.55);
        mesh.material = m;
      }
    });
    const root = new THREE.Group();
    root.add(body);
    group.add(root);
    const label = textSprite(name, color);
    label.position.set(0, 1.72, 0);
    root.add(label);
    const limbs: ChefView['limbs'] = {};
    for (const n of ['handL', 'handR', 'footL', 'footR'] as const) {
      const o = body.getObjectByName(n);
      if (o) limbs[n] = { o, p: o.position.clone() };
    }
    // a soft contact shadow, a soy puddle (Soy Slick) and a bamboo ring (shield)
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false, toneMapped: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.035;
    blob.renderOrder = 1;
    root.add(blob);
    const slick = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshStandardMaterial({ color: 0x2a140a, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 }));
    slick.rotation.x = -Math.PI / 2;
    slick.position.y = 0.04;
    slick.visible = false;
    root.add(slick);
    const shield = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.04, 8, 32), new THREE.MeshStandardMaterial({ color: 0x9bcf53, emissive: 0x4f8a1c, emissiveIntensity: 0.9 }));
    shield.rotation.x = Math.PI / 2;
    shield.position.y = 0.5;
    shield.visible = false;
    root.add(shield);
    // plates on the rack
    const plates: THREE.Object3D[] = [];
    const rack = COUNTERS.find((c) => c.type === 'plates')!;
    for (let k = 0; k < 4; k++) {
      const p = itemObject({ k: 'plate', on: [] });
      p.position.set(rack.x + 0.5, 0.96 + k * 0.04, rack.z + 0.5);
      group.add(p);
      plates.push(p);
    }
    // sabotage flash ring and selection highlight
    const flash = new THREE.Mesh(new THREE.RingGeometry(3.6, 4.6, 48), new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    flash.rotation.x = -Math.PI / 2;
    flash.position.set(POD_W / 2, 0.08, POD_H / 2);
    group.add(flash);
    const select = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.04, 1.04), new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
    select.visible = false;
    group.add(select);
    return {
      group, origin, slots, props, plates, flash, flashT: 0, flashColor: 0xff3355, select, containerIcons, lanterns,
      lamp, lampBoost: 0, emit: new Float32Array(COUNTERS.length),
      chef: { root, body, heldKey: '', held: null, label, blob, px: 4.5, pz: 4.5, bob: 0, t: 0, chop: 0, reach: 0, carry: 0, hit: 0, cheer: 0, limbs, slick, shield },
    };
  }

  /** Merge every non-animated mesh under `roots` into one mesh per material, then drop the originals. */
  private mergeStatic(group: THREE.Group, roots: THREE.Object3D[]): void {
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const rel = new THREE.Matrix4();
    const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();
    const dead: THREE.Mesh[] = [];
    for (const root of roots) {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (let p: THREE.Object3D | null = m; p && p !== group; p = p.parent) if (ANIMATED.has(p.name)) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        const attrs = Object.keys(m.geometry.attributes).sort().join(',');
        const key = `${mat.name}|${mat.color?.getHex()}|${mat.emissive?.getHex()}|${mat.emissiveIntensity}|${mat.roughness}|${mat.metalness}|${attrs}|${!!m.geometry.index}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { mat, geos: [], shadow: m.castShadow }));
        b.geos.push(m.geometry.clone().applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld)));
        dead.push(m);
      });
    }
    for (const m of dead) m.parent?.remove(m);
    for (const b of buckets.values()) {
      const geo = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, b.mat);
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = b.shadow;
      mesh.userData.merged = true;
      group.add(mesh);
    }
  }

  /** Strings of bulbs along both sides of the stall and the back lintel: one instanced mesh, one line. */
  private stringLights(group: THREE.Group, i: number): void {
    const spans: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(0.1, 2.98, -0.55), new THREE.Vector3(-0.3, 2.98, POD_H + 0.3)],
      [new THREE.Vector3(POD_W - 0.1, 2.98, -0.55), new THREE.Vector3(POD_W + 0.3, 2.98, POD_H + 0.3)],
      [new THREE.Vector3(0.1, 2.98, -0.48), new THREE.Vector3(POD_W - 0.1, 2.98, -0.48)],
    ];
    const per = 11;
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 8, 6), new THREE.MeshBasicMaterial(), spans.length * per);
    const wire: number[] = [];
    const m = new THREE.Matrix4(), c = new THREE.Color(), p = new THREE.Vector3(), prev = new THREE.Vector3();
    let k = 0;
    for (const [a, b] of spans) {
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        p.lerpVectors(a, b, t);
        p.y -= Math.sin(t * Math.PI) * 0.45; // sag
        if (s) wire.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev.copy(p);
      }
      for (let s = 0; s < per; s++) {
        const t = (s + 0.5) / per;
        p.lerpVectors(a, b, t);
        p.y -= Math.sin(t * Math.PI) * 0.45 + 0.06;
        bulbs.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z));
        // HDR colours so they bloom
        bulbs.setColorAt(k, c.setHex(BULB_COLORS[(s + i) % BULB_COLORS.length]).multiplyScalar(2.6));
        k++;
      }
    }
    group.add(bulbs);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x15101a })));
  }

  /** Push a sim state into the scene (called every frame with the latest state). */
  sync(s: State, dt: number): void {
    this.last = s;
    for (let i = 0; i < s.chefs.length; i++) {
      const c = s.chefs[i];
      const pod = this.pods[i];
      if (!pod) continue;
      this.syncChef(pod, c, i, dt);
      for (let idx = 0; idx < COUNTERS.length; idx++) {
        this.syncSlot(pod, c, COUNTERS[idx], idx, s.tick, dt, i === this.you);
        this.animateProp(pod, c, COUNTERS[idx], idx, s.tick, dt);
      }
      pod.chef.slick.visible = s.tick < c.slowUntil;
      pod.chef.shield.visible = c.shield;
      if (c.shield) pod.chef.shield.rotation.z += dt * 2;
      for (let k = 0; k < pod.plates.length; k++) pod.plates[k].visible = k < c.plates;
      if (pod.flashT > 0) {
        pod.flashT = Math.max(0, pod.flashT - dt);
        const fm = pod.flash.material as THREE.MeshBasicMaterial;
        fm.opacity = pod.flashT * 0.8;
        fm.color.setHex(pod.flashColor);
        pod.flash.scale.setScalar(1 + (1 - pod.flashT) * 0.25);
      }
      // highlight the counter you're facing
      if (i === this.you) {
        const sel = facingCounter({ x: pod.chef.px, z: pod.chef.pz, fx: c.fx, fz: c.fz });
        pod.select.visible = sel >= 0;
        if (sel >= 0) {
          pod.select.position.set(COUNTERS[sel].x + 0.5, 0.92, COUNTERS[sel].z + 0.5);
          (pod.select.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(this.clock * 6) * 0.1;
        }
      }
    }
  }

  private syncChef(pod: PodView, c: Chef, i: number, dt: number): void {
    const ch = pod.chef;
    const tx = i === this.you && this.predicted ? this.predicted.x : c.x;
    const tz = i === this.you && this.predicted ? this.predicted.z : c.z;
    const k = Math.min(1, dt * 18);
    const moving = Math.abs(tx - ch.px) + Math.abs(tz - ch.pz) > 0.004;
    ch.px += (tx - ch.px) * k;
    ch.pz += (tz - ch.pz) * k;
    ch.root.position.set(ch.px, 0.03, ch.pz);
    const yaw = Math.atan2(c.fx, c.fz);
    let d = yaw - ch.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    ch.root.rotation.y += d * Math.min(1, dt * 14);
    ch.t += dt;
    ch.bob = moving ? ch.bob + dt * 14 : ch.bob * 0.85;
    const walk = moving ? 1 : Math.min(1, Math.abs(Math.sin(ch.bob)) * 4);
    const swing = Math.sin(ch.bob);
    // squash and stretch on each step, breathing when idle; a hop when a dish lands, a wobble when hit
    const step = Math.abs(swing);
    const breathe = moving ? 0 : Math.sin(ch.t * 2.4) * 0.015;
    ch.cheer = Math.max(0, ch.cheer - dt * 1.6);
    ch.hit = Math.max(0, ch.hit - dt * 1.4);
    const hop = Math.abs(Math.sin(ch.cheer * Math.PI * 2)) * 0.22 * ch.cheer;
    ch.body.position.y = step * 0.07 * walk + hop;
    ch.body.scale.set(1 + (1 - step) * 0.04 * walk - breathe * 0.5, 1 - (1 - step) * 0.05 * walk + breathe, 1 + (1 - step) * 0.04 * walk - breathe * 0.5);
    ch.body.rotation.z = swing * 0.07 * walk + Math.sin(ch.hit * 30) * 0.2 * ch.hit;
    ch.body.rotation.y = Math.sin(ch.cheer * Math.PI * 2) * 0.4 * ch.cheer;
    ch.blob.scale.setScalar(0.95 - (step * 0.07 * walk + hop) * 0.8);
    // lean into actions
    ch.chop = Math.max(0, ch.chop - dt * 5);
    ch.reach = Math.max(0, ch.reach - dt * 4);
    ch.carry += ((c.held ? 1 : 0) - ch.carry) * Math.min(1, dt * 10);
    ch.body.rotation.x = Math.sin(ch.reach * Math.PI) * 0.22 + Math.sin(ch.chop * Math.PI) * 0.12;
    const L = ch.limbs;
    if (L.footL) L.footL.o.position.set(L.footL.p.x, L.footL.p.y + Math.max(0, swing) * 0.08 * walk, L.footL.p.z + swing * 0.12 * walk);
    if (L.footR) L.footR.o.position.set(L.footR.p.x, L.footR.p.y + Math.max(0, -swing) * 0.08 * walk, L.footR.p.z - swing * 0.12 * walk);
    const cheerUp = 0.6 * Math.min(1, ch.cheer * 3);
    for (const [n, side] of HANDS) {
      const h = L[n];
      if (!h) continue;
      // carrying: both hands up under the dish; otherwise swing opposite to the feet
      const up = ch.carry * 0.72 + (n === 'handR' ? Math.sin(ch.chop * Math.PI) * 0.35 : 0) + cheerUp * (1 - ch.carry);
      const fwd = ch.carry * 0.2 + (n === 'handR' ? ch.chop * 0.2 : 0) + ch.reach * 0.2 - side * swing * 0.12 * walk * (1 - ch.carry);
      h.o.position.set(h.p.x * (1 - ch.carry * 0.4), h.p.y + up, h.p.z + fwd);
    }
    const key = c.held ? keyOf(c.held) : '';
    if (key !== ch.heldKey) {
      if (ch.held) ch.root.remove(ch.held);
      ch.held = c.held ? itemObject(c.held) : null;
      if (ch.held) { ch.held.position.set(0, 1.32, 0.12); ch.held.scale.setScalar(1.2); ch.root.add(ch.held); }
      ch.heldKey = key;
    }
    if (ch.held) ch.held.position.y = 1.32 + Math.abs(swing) * 0.05 * walk + hop;
    ch.label.position.y = 1.72 + hop;
  }

  private syncSlot(pod: PodView, c: Chef, counter: Counter, idx: number, tick: number, dt: number, mine: boolean): void {
    const slot = pod.slots[idx];
    const st = c.st[idx];
    const it = st.item;
    const key = it ? keyOf(it) : '';
    if (key !== slot.key) {
      if (slot.obj) pod.group.remove(slot.obj);
      slot.obj = it ? itemObject(it) : null;
      if (slot.obj) {
        slot.baseY = counter.type === 'cooker' ? 1.33 : counter.type === 'pan' ? 1.03 : counter.type === 'pot' ? 1.29 : counter.type === 'board' ? 0.97 : 0.92;
        slot.obj.position.set(counter.x + 0.5, slot.baseY, counter.z + 0.5);
        pod.group.add(slot.obj);
        slot.pop = 0; // new item or new cooking state: pop in
      }
      slot.key = key;
    }
    const heat = isHeat(counter.type);
    const cooking = !!it && heat && !!COOKS[counter.type as 'cooker' | 'pan' | 'pot']?.[it.k];
    const burnRisk = !!it && heat && !!BURNS[it.k];
    if (slot.obj) {
      // raw rice cooks inside the closed cooker; you see the lid rattle and steam, then the bowl pops out
      slot.obj.visible = !(counter.type === 'cooker' && cooking);
      slot.pop = Math.min(1, slot.pop + dt * 3);
      const sc = popScale(slot.pop);
      slot.obj.scale.set(sc, 2 - sc, sc);
      // food in a hot pan sizzles; food about to burn trembles
      const burning = burnRisk ? st.p / BURNS[it!.k]!.ticks : 0;
      const sizzle = (cooking || burnRisk) && counter.type === 'pan';
      const jitter = burning > 0.5 ? 0.025 : sizzle ? 0.006 : 0;
      slot.obj.position.set(counter.x + 0.5 + (Math.random() - 0.5) * jitter, slot.baseY + (sizzle ? Math.abs(Math.sin(tick * 0.9)) * 0.01 : 0), counter.z + 0.5 + (Math.random() - 0.5) * jitter);
    }
    const prog = stationProgress(c, idx, tick);
    slot.bar.visible = !!prog && prog.p > 0;
    if (prog) {
      slot.fill.scale.x = Math.max(0.01, Math.min(1, prog.p));
      slot.fill.position.x = -0.33 * (1 - slot.fill.scale.x);
      const m = slot.fill.material as THREE.MeshBasicMaterial;
      if (prog.burning) m.color.setHex(prog.p > 0.5 && Math.floor(tick / 4) % 2 ? 0xff2a2a : 0xff8a2a);
      else m.color.setHex(0x5ee06a);
      slot.bar.quaternion.copy(this.camera.quaternion);
    }
    // continuous emitters, rate-based so they don't depend on frame rate; quieter on rivals' pods
    if (!heat || !it) return;
    const x = pod.origin.x + counter.x + 0.5, z = pod.origin.z + counter.z + 0.5;
    const scale = mine || this.overview ? 1 : 0.4;
    const rate = (r: number): number => {
      pod.emit[idx] += r * dt * scale;
      const n = Math.floor(pod.emit[idx]);
      pod.emit[idx] -= n;
      return n;
    };
    if (it.k.endsWith('_burnt')) {
      const n = rate(5);
      if (n) this.smoke.emit(x, slot.baseY + 0.2, z, 0x2a2628, n, { spread: 0.12, speed: 0.15, up: 0.55, size: 0.3, grow: 0.5, life: 2.0, alpha: 0.55 });
      return;
    }
    const burnP = prog?.burning ? prog.p : 0;
    if (burnP > 0.5) {
      const n = rate(4 + burnP * 14);
      if (n) this.smoke.emit(x, slot.baseY + 0.15, z, burnP > 0.8 ? 0x1c1a1c : 0x4a4448, n, { spread: 0.15, speed: 0.18, up: 0.7, size: 0.28, grow: 0.55, life: 1.6, alpha: 0.6 });
      return;
    }
    if (counter.type === 'cooker') {
      const n = rate(cooking ? 9 : 2.5);
      if (n) this.smoke.emit(x + 0.05, cooking ? 1.34 : 1.45, z, 0xf4f1ff, n, { spread: 0.05, speed: 0.12, up: 0.9, size: 0.2, grow: 0.45, life: 1.3, alpha: 0.4 });
    } else if (counter.type === 'pot') {
      const n = rate(cooking ? 7 : 3);
      if (n) {
        this.smoke.emit(x, 1.35, z, 0xe6f5e0, n, { spread: 0.14, speed: 0.1, up: 0.75, size: 0.24, grow: 0.4, life: 1.4, alpha: 0.35 });
        if (cooking) this.glow.emit(x, 1.3, z, 0x9be05a, 1, { spread: 0.12, speed: 0.05, up: 0.25, size: 0.05, life: 0.5, alpha: 0.7 });
      }
    } else if (counter.type === 'pan' && (cooking || burnRisk)) {
      const n = rate(16);
      if (n) {
        this.glow.emit(x, 1.08, z, 0xffb14a, n, { spread: 0.16, speed: 0.9, up: 1.2, size: 0.045, gravity: 6, life: 0.45, alpha: 1 });
        if (Math.random() < 0.4) this.smoke.emit(x, 1.12, z, 0xfff4e6, 1, { spread: 0.12, speed: 0.1, up: 0.6, size: 0.2, grow: 0.35, life: 1.0, alpha: 0.3 });
      }
      if (mine) this.stoveHeat = Math.max(this.stoveHeat, 1);
    }
  }

  /** Station machinery: knife, pan, flame, broth, cooker lid, bell, container icon squash. */
  private animateProp(pod: PodView, c: Chef, counter: Counter, idx: number, tick: number, dt: number): void {
    const pr = pod.props[idx];
    pr.t = Math.max(0, pr.t - dt * 4);
    const P = pr.parts, R = pr.rest;
    const it = c.st[idx].item;
    const time = tick / 20;
    const kick = Math.sin(pr.t * Math.PI);
    switch (counter.type) {
      case 'board':
        // the knife lifts and comes down on every chop
        if (P.blade) { P.blade.rotation.x = R.blade.r.x - kick * 0.7; P.blade.position.y = R.blade.p.y + kick * 0.05; }
        break;
      case 'pan':
        if (P.pan) { P.pan.rotation.z = R.pan.r.z + (it ? Math.sin(time * 18) * 0.04 : 0) + kick * 0.12; P.pan.position.x = R.pan.p.x + (it ? Math.sin(time * 9) * 0.01 : 0); P.pan.position.y = R.pan.p.y + kick * 0.06; }
        if (P.flame) { const f = it ? 1 + Math.sin(this.clock * 31 + idx) * 0.12 + Math.random() * 0.1 : 0.55; P.flame.scale.set(f, it ? f * 1.4 : 0.6, f); }
        break;
      case 'pot':
        if (P.broth) P.broth.position.y = R.broth.p.y + (it ? Math.sin(time * 6) * 0.008 : 0);
        if (P.flame) { const f = it ? 1 + Math.sin(this.clock * 27 + idx) * 0.12 : 0.55; P.flame.scale.set(f, it ? f * 1.3 : 0.6, f); }
        break;
      case 'cooker':
        // the lid rattles while rice cooks, and jumps when it's done
        if (P.lid) {
          const rattle = it && COOKS.cooker[it.k] ? Math.sin(time * 40) * 0.012 : 0;
          P.lid.position.y = R.lid.p.y + Math.abs(rattle) + kick * 0.14;
          P.lid.rotation.y = R.lid.r.y + rattle * 2;
          P.lid.rotation.x = R.lid.r.x + kick * 0.15;
        }
        break;
      case 'delivery':
        if (P.bell) P.bell.position.y = R.bell.p.y - kick * 0.04;
        break;
      case 'container': {
        const icon = pod.containerIcons[idx];
        if (icon) {
          icon.scale.set(1.1 + kick * 0.2, 1.1 - kick * 0.25, 1.1 + kick * 0.2);
          icon.position.y = 0.97 + kick * 0.12;
        }
        break;
      }
    }
  }

  /** Sim events drive one-shot animations and effects. Call for every event, every chef. */
  onEvent(e: SimEvent): void {
    const kick = (chef: number, counter: number): void => { const p = this.pods[chef]; if (p && counter >= 0) p.props[counter].t = 1; };
    switch (e.t) {
      case 'chop': {
        kick(e.chef, e.counter);
        const p = this.pods[e.chef];
        if (!p) break;
        p.chef.chop = 1;
        const k = this.last?.chefs[e.chef]?.st[e.counter]?.item?.k ?? '';
        const col = CHIP_COLOR[k.split('_')[0]] ?? 0xfff3e0;
        this.at(p, e.counter, 1.0, (x, y, z) => this.chips.emit(x, y, z, col, 5, { spread: 0.12, speed: 0.9, up: 1.4, size: 0.05, gravity: 7, life: 0.6, alpha: 1 }));
        break;
      }
      case 'pick': case 'place': case 'trash': case 'serve': {
        const p = this.pods[e.chef];
        if (p) p.chef.reach = 1;
        if (e.t !== 'place' && COUNTERS[e.counter]?.type !== 'clear') kick(e.chef, e.counter);
        if (!p) break;
        if (e.t === 'place') this.at(p, e.counter, 0.95, (x, y, z) => this.smoke.emit(x, y, z, 0xd8cfc0, 3, { spread: 0.2, speed: 0.4, up: 0.15, size: 0.12, life: 0.5, drag: 3, alpha: 0.35 }));
        if (e.t === 'trash') this.at(p, e.counter, 1.45, (x, y, z) => this.chips.emit(x, y, z, 0x5a4a3a, 8, { spread: 0.15, speed: 0.8, up: 1.4, size: 0.06, gravity: 6, life: 0.7 }));
        if (e.t === 'serve') this.at(p, e.counter, 1.2, (x, y, z) => this.glow.emit(x, y, z, 0xffd23f, 14, { spread: 0.25, speed: 1.4, up: 1.6, size: 0.07, gravity: 4, life: 0.8 }));
        break;
      }
      case 'cooked': {
        kick(e.chef, e.counter);
        const p = this.pods[e.chef];
        if (p) this.at(p, e.counter, 1.3, (x, y, z) => {
          this.smoke.emit(x, y, z, 0xffffff, 12, { spread: 0.18, speed: 0.6, up: 1.1, size: 0.26, grow: 0.5, drag: 1.5, life: 1.2, alpha: 0.5 });
          this.glow.emit(x, y + 0.1, z, 0xfff1a8, 10, { spread: 0.25, speed: 0.6, up: 0.9, size: 0.06, gravity: 1, life: 0.7 });
        });
        break;
      }
      case 'burn': {
        const p = this.pods[e.chef];
        if (!p) break;
        this.at(p, e.counter, 1.2, (x, y, z) => {
          this.smoke.emit(x, y, z, 0x18161a, 26, { spread: 0.25, speed: 0.7, up: 1.3, size: 0.36, grow: 0.7, drag: 1.2, life: 2.0, alpha: 0.75 });
          this.glow.emit(x, y, z, 0xff6a1a, 18, { spread: 0.2, speed: 1.6, up: 2.0, size: 0.06, gravity: 5, life: 0.8 });
          this.pops.show('Burnt!', '#ff6b4a', x, y + 0.7, z);
        });
        p.flashColor = 0xff6a1a; p.flashT = 0.6;
        p.chef.hit = 0.6;
        if (e.chef === this.you) { this.shake = Math.max(this.shake, 0.5); this.stoveHeat = 2.5; }
        break;
      }
      case 'deliver': {
        const p = this.pods[e.chef];
        if (!p) break;
        kick(e.chef, DELIVERY);
        this.confetti(p, e.points, e.tip);
        p.chef.cheer = 1;
        p.lampBoost = 1;
        p.flashColor = 0xffd23f; p.flashT = 0.7;
        if (e.chef === this.you) this.shake = Math.max(this.shake, 0.25);
        break;
      }
      case 'wrong': {
        const p = this.pods[e.chef];
        if (!p) break;
        this.at(p, DELIVERY, 1.3, (x, y, z) => { this.smoke.emit(x, y, z, 0xff4a4a, 10, { spread: 0.3, speed: 0.6, up: 0.6, size: 0.18, life: 0.8, alpha: 0.6 }); this.pops.show('−5', '#ff5a5a', x, y + 0.6, z, 'wrong dish'); });
        p.chef.hit = 0.5;
        break;
      }
      case 'expire': {
        const p = this.pods[e.chef];
        if (p) this.at(p, DELIVERY, 1.3, (x, y, z) => { this.smoke.emit(x, y, z, 0x9fb8ff, 12, { spread: 0.4, speed: 0.3, up: 0.5, size: 0.2, life: 1.2, alpha: 0.45 }); this.pops.show('−15', '#9fc2ff', x, y + 0.6, z, 'went cold'); });
        break;
      }
      case 'cast': {
        const p = this.pods[e.caster];
        if (p) this.glow.emit(p.origin.x + p.chef.px, 0.9, p.origin.z + p.chef.pz, 0xc37bff, 16, { spread: 0.3, speed: 0.8, up: 1.2, size: 0.07, gravity: 0.5, life: 0.9 });
        break;
      }
      case 'sabotaged':
        if (!e.blocked) this.sabotageFx(e.target, e.card);
        else {
          const p = this.pods[e.target];
          if (p) { p.flashColor = 0x9bcf53; p.flashT = 1; this.glow.emit(p.origin.x + p.chef.px, 0.6, p.origin.z + p.chef.pz, 0x9bcf53, 24, { spread: 0.5, speed: 1.2, up: 0.8, size: 0.07, life: 0.8 }); }
        }
        break;
    }
  }

  /** Run fn with the world position of a counter in a pod. */
  private at(p: PodView, counter: number, y: number, fn: (x: number, y: number, z: number) => void): void {
    const c = COUNTERS[counter];
    if (c) fn(p.origin.x + c.x + 0.5, y, p.origin.z + c.z + 0.5);
  }

  private confetti(pod: PodView, points: number, tip: number): void {
    this.at(pod, DELIVERY, 1.3, (x, y, z) => {
      for (const col of [0xff6a3c, 0xffd23f, 0x5ee06a, 0x2f8fe0, 0xff7ac8]) this.chips.emit(x, y, z, col, 9, { spread: 0.3, speed: 1.6, up: 3.2, size: 0.07, gravity: 5, drag: 1.2, life: 1.6, alpha: 1 });
      this.glow.emit(x, y, z, 0xffcf3a, 22, { spread: 0.2, speed: 1.8, up: 2.6, size: 0.08, gravity: 6, life: 1.0 });
      this.pops.show(`+${points}`, '#ffd23f', x, y + 0.8, z, tip ? `tip +${tip}` : '');
    });
  }

  private sabotageFx(target: number, card: Card): void {
    const p = this.pods[target];
    if (!p) return;
    p.flashColor = 0xff3355;
    p.flashT = 1;
    p.chef.hit = 1;
    if (target === this.you) this.shake = Math.max(this.shake, 0.8);
    const cx = p.origin.x + p.chef.px, cz = p.origin.z + p.chef.pz;
    this.smoke.emit(cx, 0.9, cz, 0x8e5bd8, 22, { spread: 0.35, speed: 1.0, up: 0.8, size: 0.32, grow: 0.5, drag: 2, life: 1.2, alpha: 0.65 });
    this.glow.emit(cx, 1.0, cz, 0xff5aa8, 22, { spread: 0.2, speed: 2.2, up: 1.6, size: 0.06, gravity: 4, life: 0.7 });
    const burst = (idx: number, col: number, y: number): void => this.at(p, idx, y, (x, yy, z) => {
      this.smoke.emit(x, yy, z, col, 14, { spread: 0.3, speed: 1.2, up: 1.2, size: 0.22, grow: 0.3, drag: 2, life: 1.0, alpha: 0.7 });
      this.glow.emit(x, yy, z, col, 10, { spread: 0.2, speed: 1.6, up: 1.4, size: 0.06, gravity: 4, life: 0.6 });
    });
    COUNTERS.forEach((c, k) => {
      if (card === 'wasabi_bomb' && (c.type === 'pan' || c.type === 'cooker')) burst(k, 0x7bd23a, 1.2);
      if (card === 'dull_knife' && c.type === 'board') burst(k, 0xcfd8e3, 1.0);
      if (card === 'fish_swap' && c.x === 4 && c.z === 3) burst(k, 0xff8a5c, 1.1);
      if (card === 'order_shuffle' && c.type === 'delivery') burst(k, 0xf1e2c2, 1.6);
    });
  }

  // ---------- effects ----------

  /** Point the tutorial arrow at one of your counters (or hide it with -1). */
  setHint(counter: number): void {
    this.hintCounter = counter;
    this.hint.visible = counter >= 0;
  }

  flashPod(i: number): void { const p = this.pods[i]; if (p) p.flashT = 1; }

  burst(i: number, counterIdx: number, color: number, n = 10): void {
    const p = this.pods[i];
    if (p) this.at(p, counterIdx, 1.2, (x, y, z) => this.glow.emit(x, y, z, color, n, { spread: 0.2, speed: 1.5, up: 1.6, size: 0.07, gravity: 3, life: 0.8 }));
  }

  render(dt: number): void {
    this.clock += dt;
    this.smoke.update(dt);
    this.glow.update(dt);
    this.chips.update(dt);
    this.pops.update(dt);
    // street steam
    this.ventAcc += dt * 3;
    while (this.ventAcc >= 1) {
      this.ventAcc -= 1;
      const v = this.vents[Math.floor(Math.random() * this.vents.length)];
      if (v) this.smoke.emit(v.x, v.y, v.z, 0xcfc8e8, 1, { spread: 0.25, speed: 0.12, up: 0.5, size: 0.5, grow: 0.6, life: 3.2, alpha: 0.22 });
    }
    for (let i = 0; i < this.pods.length; i++) {
      const p = this.pods[i];
      for (let k = 0; k < p.lanterns.length; k++) { const l = p.lanterns[k]; l.rotation.z = Math.sin(this.clock * 1.3 + k + i) * 0.06; l.rotation.x = Math.sin(this.clock * 0.9 + k * 2) * 0.04; }
      p.lampBoost = Math.max(0, p.lampBoost - dt * 1.5);
      p.lamp.intensity = 14 + Math.sin(this.clock * 3 + i) * 0.6 + p.lampBoost * 14;
    }
    // the stove light over your own pan flickers while it cooks, flares when something burns
    const you = this.pods[this.you];
    this.stoveHeat = Math.max(0, this.stoveHeat - dt * 2.5);
    if (you) {
      this.stove.position.set(you.origin.x + PAN.x + 0.5, 1.5, you.origin.z + PAN.z + 0.7);
      this.stove.intensity = Math.min(1, this.stoveHeat) * (2.2 + Math.sin(this.clock * 23) * 0.4 + Math.random() * 0.4) + Math.max(0, this.stoveHeat - 1) * 3;
    }
    if (this.hintCounter >= 0) {
      this.hintT += dt;
      const o = you?.origin ?? podOrigin(this.you);
      const c = COUNTERS[this.hintCounter];
      this.hint.position.set(o.x + c.x + 0.5, 1.65 + Math.sin(this.hintT * 5) * 0.1, o.z + c.z + 0.5);
      this.hint.rotation.y += dt * 2;
    }
    this.updateCamera(dt);
    this.watchPerf(dt);
    if (this.bloomOn) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Frame your own pod (with a little lead toward your chef) or the whole market, fitted to the screen shape. */
  private updateCamera(dt: number): void {
    const you = this.pods[this.you];
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    let w: number, d: number, elev: number;
    const target = this.v1;
    if (this.overview || !you) {
      const n = Math.max(1, this.pods.length), cols = n > 1 ? 2 : 1, rows = Math.ceil(n / 2);
      w = cols * POD_W + (cols - 1) * GAP_X + 1.5;
      d = rows * POD_H + (rows - 1) * GAP_Z + 1.5;
      elev = THREE.MathUtils.degToRad(52);
      target.set((cols * POD_W + (cols - 1) * GAP_X) / 2 + Math.sin(this.clock * 0.12) * 0.8, 0, (rows * POD_H + (rows - 1) * GAP_Z) / 2 - 0.4);
    } else {
      w = POD_W + 1.6;
      d = POD_H + 1.2;
      elev = THREE.MathUtils.degToRad(55);
      target.set(you.origin.x + POD_W / 2 + (you.chef.px - POD_W / 2) * 0.22, 0, you.origin.z + POD_H / 2 - 0.6 + (you.chef.pz - POD_H / 2) * 0.18);
    }
    // the depth seen on screen shrinks with the camera's tilt; the back wall and sign add height
    const distW = w / 2 / Math.tan(hfov / 2);
    const distD = (d * Math.sin(elev) + 4.2 * Math.cos(elev)) / 2 / Math.tan(vfov / 2);
    const dist = Math.max(distW, distD) * (this.overview ? 1.3 : 1.18);
    const pos = this.v2.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist).add(target);
    const k = Math.min(1, dt * 4);
    this.camTarget.lerp(target, k);
    this.camPos.lerp(pos, k);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const a = this.shake * this.shake * 0.18;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
    }
    this.camera.lookAt(this.camTarget);
    // keep the moon's shadow map tight around what's on screen
    const half = this.overview ? Math.ceil(Math.max(w, d) * 0.62) : 8;
    const sc = this.moon.shadow.camera;
    if (sc.right !== half) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.updateProjectionMatrix(); }
    this.moon.target.position.copy(this.camTarget);
    this.moon.position.set(this.camTarget.x - 8, 18, this.camTarget.z + 4);
    this.moon.target.updateMatrixWorld();
  }

  /** If frames run long for a few seconds: drop bloom, then pixel ratio, then shadow resolution. */
  private watchPerf(dt: number): void {
    const f = this.perf;
    const now = performance.now();
    f.warm += dt;
    if (f.last && document.visibilityState === 'visible') {
      const ms = now - f.last;
      if (ms < 250) { f.acc += ms; f.n++; }
    }
    f.last = now;
    if (f.n < 120) return;
    const avg = f.acc / f.n;
    f.acc = 0; f.n = 0;
    if (f.warm < 4 || avg < 24) { f.strikes = 0; return; }
    if (++f.strikes < 2) return;
    f.strikes = 0;
    if (this.bloomOn) this.bloomOn = false;
    else if (this.pixelRatio > 1) { this.pixelRatio = 1; this.renderer.setPixelRatio(1); this.resize(); }
    else if (this.moon.shadow.mapSize.x > 1024) { this.moon.shadow.mapSize.set(1024, 1024); this.moon.shadow.map?.dispose(); this.moon.shadow.map = null; }
  }

  /** Screen position of a pod's centre, for HUD labels. */
  podScreen(i: number): { x: number; y: number } | null {
    const o = podOrigin(i);
    const v = new THREE.Vector3(o.x + POD_W / 2, 2.6, o.z + POD_H / 2).project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x + 1) / 2 * this.canvas.clientWidth, y: (1 - v.y) / 2 * this.canvas.clientHeight };
  }
}

function textSprite(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '600 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(10,8,16,0.65)';
  const w = Math.min(250, g.measureText(text).width + 28);
  g.beginPath(); g.roundRect((256 - w) / 2, 8, w, 48, 22); g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillText(text, 128, 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false }));
  s.scale.set(1.4, 0.35, 1);
  s.renderOrder = 20;
  s.visible = !!text;
  return s;
}
