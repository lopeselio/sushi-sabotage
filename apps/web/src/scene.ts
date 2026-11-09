import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BURNS, COOKS, COUNTERS, POD_H, POD_W, facingCounter, isHeat, stationProgress, type Card, type Chef, type Counter, type SimEvent, type State } from '@sushi/rules';
import { itemObject, keyOf, setFoodModels } from './food.ts';

// The night-market kitchen. Pods are laid out 2x2 on a wet stone street; the camera follows yours.

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
  root: THREE.Object3D; body: THREE.Object3D; heldKey: string; held: THREE.Object3D | null; label: THREE.Sprite;
  px: number; pz: number; bob: number; t: number; chop: number; reach: number; carry: number;
  limbs: Partial<Record<'handL' | 'handR' | 'footL' | 'footR', Limb>>;
  slick: THREE.Mesh; shield: THREE.Mesh;
}
interface PodView { group: THREE.Group; slots: Slot[]; props: Prop[]; chef: ChefView; plates: THREE.Object3D[]; flash: THREE.Mesh; flashT: number; flashColor: number; select: THREE.Mesh; containerIcons: THREE.Object3D[]; lanterns: THREE.Object3D[] }
interface Particle { p: THREE.Points; v: Float32Array; life: number; max: number; gravity: number }

const ANIMATED = ['blade', 'handle', 'pan', 'flame', 'broth', 'lid', 'knob', 'bell', 'crate', 'plate0', 'plate1', 'plate2'];
const ease = (t: number): number => 1 - (1 - t) * (1 - t);
/** A springy 0→1 pop curve for squash and stretch: overshoots, then settles. */
const popScale = (t: number): number => (t >= 1 ? 1 : 1 + Math.sin(t * Math.PI * 2.5) * 0.35 * (1 - t));

export class KitchenScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private composer: EffectComposer;
  private models = new Map<string, THREE.Object3D>();
  private pods: PodView[] = [];
  private particles: Particle[] = [];
  private hint: THREE.Mesh;
  private hintCounter = -1;
  private hintT = 0;
  private clock = 0;
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  overview = false;
  you = 0;
  /** your own chef's predicted position (multiplayer), overrides the snapshot */
  predicted: { x: number; z: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.scene.background = new THREE.Color(0x120d1c);
    this.scene.fog = new THREE.Fog(0x120d1c, 18, 48);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.35, 0.5, 0.92));
    this.composer.addPass(new OutputPass());
    this.lights();
    this.hint = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 16), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xff9f00, emissiveIntensity: 0.5 }));
    this.hint.rotation.x = Math.PI;
    this.hint.visible = false;
    this.scene.add(this.hint);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const names = ['chef', 'counter', 'board', 'cooker', 'pan', 'pot', 'plates', 'delivery', 'trash', 'container', 'lantern', 'noren', 'food'];
    await Promise.all(names.map(async (n) => {
      const g = await loader.loadAsync(`/models/${n}.glb`);
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.models.set(n, g.scene);
    }));
    setFoodModels(this.models.get('food')!);
  }

  private lights(): void {
    this.scene.add(new THREE.HemisphereLight(0xa99be0, 0x2a1c30, 1.0));
    // a warm key light so the stalls read clearly at night
    const key = new THREE.DirectionalLight(0xffd9a8, 0.6);
    key.position.set(6, 12, 20);
    this.scene.add(key);
    const moon = new THREE.DirectionalLight(0xbfc8ff, 1.1);
    moon.position.set(-8, 18, 6);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const sc = moon.shadow.camera;
    sc.left = -6; sc.right = 30; sc.top = 8; sc.bottom = -26; sc.far = 60;
    moon.target.position.set(10, 0, 9);
    this.scene.add(moon, moon.target);
    // the street
    const street = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x1d1a24, roughness: 0.25, metalness: 0.2 }));
    street.rotation.x = -Math.PI / 2;
    street.position.set(10, -0.01, 9);
    street.receiveShadow = true;
    this.scene.add(street);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private model(n: string): THREE.Object3D {
    return this.models.get(n)!.clone(true);
  }

  /** Build the pods for a match. */
  build(names: string[], you: number): void {
    for (const p of this.pods) this.scene.remove(p.group);
    this.pods = [];
    this.you = you;
    names.forEach((name, i) => this.pods.push(this.buildPod(i, name)));
    const o = podOrigin(you);
    this.camTarget.set(o.x + POD_W / 2, 0, o.z + POD_H / 2);
    this.camPos.copy(this.camTarget).add(new THREE.Vector3(0, 11, 8.5));
  }

  private buildPod(i: number, name: string): PodView {
    const group = new THREE.Group();
    group.position.copy(podOrigin(i));
    this.scene.add(group);
    // floor tiles
    const floor = new THREE.Mesh(new THREE.BoxGeometry(POD_W, 0.06, POD_H), new THREE.MeshStandardMaterial({ color: i === this.you ? 0x4a3a2c : 0x3a2f28, roughness: 0.8 }));
    floor.position.set(POD_W / 2, 0.0, POD_H / 2);
    floor.receiveShadow = true;
    group.add(floor);
    const slots: Slot[] = [];
    const props: Prop[] = [];
    const containerIcons: THREE.Object3D[] = [];
    for (const c of COUNTERS) {
      const m = this.model(MODEL_FOR[c.type]);
      m.position.set(c.x + 0.5, 0, c.z + 0.5);
      m.rotation.y = counterYaw(c);
      group.add(m);
      const prop: Prop = { root: m, parts: {}, rest: {}, t: 0 };
      for (const n of ANIMATED) {
        const o = m.getObjectByName(n);
        if (o) { prop.parts[n] = o; prop.rest[n] = { p: o.position.clone(), r: o.rotation.clone() }; }
      }
      props.push(prop);
      if (c.type === 'container' && c.source) {
        const icon = itemObject({ k: c.source });
        icon.position.set(c.x + 0.5, 1.0, c.z + 0.5);
        icon.scale.setScalar(1.1);
        group.add(icon);
        containerIcons.push(icon);
      }
      const bar = new THREE.Group();
      const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.1), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.75, depthTest: false }));
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.06), new THREE.MeshBasicMaterial({ color: 0x5ee06a, depthTest: false }));
      fill.position.z = 0.001;
      bg.renderOrder = 10; fill.renderOrder = 11;
      bar.add(bg, fill);
      bar.position.set(c.x + 0.5, 1.75, c.z + 0.5);
      bar.visible = false;
      group.add(bar);
      slots.push({ key: '', obj: null, bar, fill, pop: 1, baseY: 0.92 });
    }
    // lanterns and a noren curtain at the front of the stall
    const lanterns: THREE.Object3D[] = [];
    for (const x of [1.5, POD_W - 1.5]) {
      const l = this.model('lantern');
      l.position.set(x, 2.6, POD_H + 0.4);
      group.add(l);
      lanterns.push(l);
    }
    const lamp = new THREE.PointLight(0xffa860, 10, 14, 1.2);
    lamp.position.set(POD_W / 2, 5.5, POD_H / 2 + 1.5);
    group.add(lamp);
    const noren = this.model('noren');
    noren.position.set(POD_W / 2, 0.6, -0.6);
    group.add(noren);
    // chef
    const body = this.model('chef');
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.Material).name.startsWith('Tint')) {
        mesh.material = (mesh.material as THREE.MeshStandardMaterial).clone();
        (mesh.material as THREE.MeshStandardMaterial).color.setHex(CHEF_COLORS[i % CHEF_COLORS.length]);
      }
    });
    const root = new THREE.Group();
    root.add(body);
    group.add(root);
    const label = textSprite(name, CHEF_COLORS[i % CHEF_COLORS.length]);
    label.position.set(0, 1.55, 0);
    root.add(label);
    const limbs: ChefView['limbs'] = {};
    for (const n of ['handL', 'handR', 'footL', 'footR'] as const) {
      const o = body.getObjectByName(n);
      if (o) limbs[n] = { o, p: o.position.clone() };
    }
    // a soy puddle under the chef (Soy Slick) and a bamboo ring (shield), hidden until needed
    const slick = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshStandardMaterial({ color: 0x2a140a, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 }));
    slick.rotation.x = -Math.PI / 2;
    slick.position.y = 0.04;
    slick.visible = false;
    root.add(slick);
    const shield = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.04, 8, 32), new THREE.MeshStandardMaterial({ color: 0x9bcf53, emissive: 0x4f8a1c, emissiveIntensity: 0.6 }));
    shield.rotation.x = Math.PI / 2;
    shield.position.y = 0.5;
    shield.visible = false;
    root.add(shield);
    // plates on the rack
    const plates: THREE.Object3D[] = [];
    const rack = COUNTERS.find((c) => c.type === 'plates')!;
    for (let k = 0; k < 4; k++) {
      const p = itemObject({ k: 'plate', on: [] });
      p.position.set(rack.x + 0.5, 1.0 + k * 0.04, rack.z + 0.5);
      group.add(p);
      plates.push(p);
    }
    // sabotage flash ring and selection highlight
    const flash = new THREE.Mesh(new THREE.RingGeometry(3.6, 4.6, 48), new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    flash.rotation.x = -Math.PI / 2;
    flash.position.set(POD_W / 2, 0.08, POD_H / 2);
    group.add(flash);
    const select = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.04, 1.04), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    select.visible = false;
    group.add(select);
    return {
      group, slots, props, plates, flash, flashT: 0, flashColor: 0xff3355, select, containerIcons, lanterns,
      chef: { root, body, heldKey: '', held: null, label, px: 4.5, pz: 4.5, bob: 0, t: 0, chop: 0, reach: 0, carry: 0, limbs, slick, shield },
    };
  }

  /** Push a sim state into the scene (called every frame with the latest state). */
  sync(s: State, dt: number): void {
    s.chefs.forEach((c, i) => {
      const pod = this.pods[i];
      if (!pod) return;
      this.syncChef(pod, c, i, dt);
      COUNTERS.forEach((counter, idx) => { this.syncSlot(pod, c, counter, idx, s.tick, dt); this.animateProp(pod, c, counter, idx, s.tick, dt); });
      pod.chef.slick.visible = s.tick < c.slowUntil;
      pod.chef.shield.visible = c.shield;
      if (c.shield) pod.chef.shield.rotation.z += dt * 2;
      pod.plates.forEach((p, k) => { p.visible = k < c.plates; });
      if (pod.flashT > 0) {
        pod.flashT = Math.max(0, pod.flashT - dt);
        const fm = pod.flash.material as THREE.MeshBasicMaterial;
        fm.opacity = pod.flashT * 0.8;
        fm.color.setHex(pod.flashColor);
      }
      // highlight the counter you're facing
      if (i === this.you) {
        const sel = facingCounter({ x: pod.chef.px, z: pod.chef.pz, fx: c.fx, fz: c.fz });
        pod.select.visible = sel >= 0;
        if (sel >= 0) pod.select.position.set(COUNTERS[sel].x + 0.5, 0.92, COUNTERS[sel].z + 0.5);
      }
    });
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
    // squash and stretch on each step, a little breathing when idle
    const step = Math.abs(swing);
    const breathe = moving ? 0 : Math.sin(ch.t * 2.4) * 0.015;
    ch.body.position.y = step * 0.07 * walk;
    ch.body.scale.set(1 + (1 - step) * 0.04 * walk - breathe * 0.5, 1 - (1 - step) * 0.05 * walk + breathe, 1 + (1 - step) * 0.04 * walk - breathe * 0.5);
    ch.body.rotation.z = swing * 0.07 * walk;
    // lean into actions
    ch.chop = Math.max(0, ch.chop - dt * 5);
    ch.reach = Math.max(0, ch.reach - dt * 4);
    ch.carry += ((c.held ? 1 : 0) - ch.carry) * Math.min(1, dt * 10);
    ch.body.rotation.x = Math.sin(ch.reach * Math.PI) * 0.22 + Math.sin(ch.chop * Math.PI) * 0.12;
    const L = ch.limbs;
    if (L.footL) L.footL.o.position.set(L.footL.p.x, L.footL.p.y + Math.max(0, swing) * 0.08 * walk, L.footL.p.z + swing * 0.12 * walk);
    if (L.footR) L.footR.o.position.set(L.footR.p.x, L.footR.p.y + Math.max(0, -swing) * 0.08 * walk, L.footR.p.z - swing * 0.12 * walk);
    for (const [k, side] of [['handL', 1], ['handR', -1]] as const) {
      const h = L[k];
      if (!h) continue;
      // carrying: both hands up and forward; otherwise swing opposite to the feet
      const up = ch.carry * 0.55 + (k === 'handR' ? Math.sin(ch.chop * Math.PI) * 0.35 : 0);
      const fwd = ch.carry * 0.22 + (k === 'handR' ? ch.chop * 0.2 : 0) + ch.reach * 0.2 - side * swing * 0.12 * walk * (1 - ch.carry);
      h.o.position.set(h.p.x * (1 - ch.carry * 0.35), h.p.y + up, h.p.z + fwd);
    }
    const key = c.held ? keyOf(c.held) : '';
    if (key !== ch.heldKey) {
      if (ch.held) ch.root.remove(ch.held);
      ch.held = c.held ? itemObject(c.held) : null;
      if (ch.held) { ch.held.position.set(0, 1.32, 0.12); ch.held.scale.setScalar(1.25); ch.root.add(ch.held); }
      ch.heldKey = key;
    }
    if (ch.held) ch.held.position.y = 1.32 + Math.abs(swing) * 0.05 * walk;
    ch.label.lookAt(this.camera.position);
  }

  private syncSlot(pod: PodView, c: Chef, counter: Counter, idx: number, tick: number, dt: number): void {
    const slot = pod.slots[idx];
    const it = c.st[idx].item;
    const key = it ? keyOf(it) : '';
    if (key !== slot.key) {
      if (slot.obj) pod.group.remove(slot.obj);
      slot.obj = it ? itemObject(it) : null;
      if (slot.obj) {
        slot.baseY = counter.type === 'cooker' ? 1.33 : counter.type === 'pan' ? 1.04 : counter.type === 'pot' ? 1.3 : 0.92;
        slot.obj.position.set(counter.x + 0.5, slot.baseY, counter.z + 0.5);
        pod.group.add(slot.obj);
        slot.pop = 0; // new item or new cooking state: pop in
      }
      slot.key = key;
    }
    if (slot.obj) {
      // raw rice cooks inside the closed cooker; you see the lid rattle and steam, then the bowl pops out
      slot.obj.visible = !(counter.type === 'cooker' && it && COOKS.cooker[it.k]);
      slot.pop = Math.min(1, slot.pop + dt * 3);
      const sc = popScale(slot.pop);
      slot.obj.scale.set(sc, 2 - sc, sc);
      // food sitting in a hot pan sizzles; food about to burn trembles
      const burning = it && BURNS[it.k] && isHeat(counter.type) ? c.st[idx].p / BURNS[it.k]!.ticks : 0;
      const cooking = it && isHeat(counter.type);
      const jitter = burning > 0.5 ? 0.025 : cooking && counter.type === 'pan' ? 0.006 : 0;
      slot.obj.position.set(counter.x + 0.5 + (Math.random() - 0.5) * jitter, slot.baseY + (cooking && counter.type === 'pan' ? Math.abs(Math.sin(tick * 0.9)) * 0.01 : 0), counter.z + 0.5 + (Math.random() - 0.5) * jitter);
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
      if (prog.burning && prog.p > 0.5 && tick % 5 === 0) this.puff(pod, counter, 0x3a3a3a, 5, 0.6, 1.25);
    }
    if (counter.type === 'pot' && it && tick % 8 === 0) this.puff(pod, counter, 0xe8f5e0, 2, 0.4, 1.4);
    if (counter.type === 'pan' && it && !prog?.burning && tick % 4 === 0) this.puff(pod, counter, 0xffe6a0, 2, 1.4, 1.1, 3); // oil spits
    if (counter.type === 'cooker' && it && tick % 12 === 0) this.puff(pod, counter, 0xffffff, 2, 0.3, 1.5);
  }

  /** Station machinery: knife, pan, flame, broth, cooker lid, bell, crate, plate stack. */
  private animateProp(pod: PodView, c: Chef, counter: Counter, idx: number, tick: number, dt: number): void {
    const pr = pod.props[idx];
    pr.t = Math.max(0, pr.t - dt * 4);
    const P = pr.parts, R = pr.rest;
    const it = c.st[idx].item;
    const time = tick / 20;
    switch (counter.type) {
      case 'board':
        // the knife comes down on every chop
        for (const n of ['blade', 'handle']) if (P[n]) { P[n].rotation.x = R[n].r.x - Math.sin(pr.t * Math.PI) * 0.9; P[n].position.y = R[n].p.y + Math.sin(pr.t * Math.PI) * 0.06; }
        break;
      case 'pan':
        if (P.pan) { P.pan.rotation.z = R.pan.r.z + (it ? Math.sin(time * 18) * 0.04 : 0); P.pan.position.x = R.pan.p.x + (it ? Math.sin(time * 9) * 0.01 : 0); }
        if (P.flame) { const f = it ? 1 + Math.sin(time * 31) * 0.15 + Math.random() * 0.1 : 0.6; P.flame.scale.set(f, f, it ? f * 1.4 : 0.6); }
        break;
      case 'pot':
        if (P.broth) P.broth.position.y = R.broth.p.y + (it ? Math.sin(time * 6) * 0.012 : 0);
        if (P.flame) { const f = it ? 1 + Math.sin(time * 27) * 0.15 : 0.6; P.flame.scale.set(f, f, f); }
        if (it && tick % 7 === 0) this.puff(pod, counter, 0x9be05a, 1, 0.15, 1.32, 0.5);
        break;
      case 'cooker':
        // the lid rattles while rice cooks, and jumps when it's done
        if (P.lid) {
          const rattle = it && isHeat('cooker') && !BURNS[it.k] ? Math.sin(time * 40) * 0.012 : 0;
          P.lid.position.y = R.lid.p.y + Math.abs(rattle) + Math.sin(pr.t * Math.PI) * 0.12;
          P.lid.rotation.y = R.lid.r.y + rattle * 2;
          if (P.knob) P.knob.position.y = R.knob.p.y + Math.abs(rattle) + Math.sin(pr.t * Math.PI) * 0.12;
        }
        break;
      case 'delivery':
        if (P.bell) P.bell.position.y = R.bell.p.y - Math.sin(pr.t * Math.PI) * 0.04;
        break;
      case 'container':
        pr.root.scale.set(1 + Math.sin(pr.t * Math.PI) * 0.06, 1 - Math.sin(pr.t * Math.PI) * 0.08, 1 + Math.sin(pr.t * Math.PI) * 0.06);
        break;
      case 'trash':
        pr.root.rotation.z = Math.sin(pr.t * Math.PI * 3) * 0.06 * pr.t;
        break;
    }
  }

  /** Sim events drive one-shot animations and effects. Call for every event, every chef. */
  onEvent(e: SimEvent): void {
    const kick = (chef: number, counter: number): void => { const p = this.pods[chef]; if (p && counter >= 0) p.props[counter].t = 1; };
    switch (e.t) {
      case 'chop': {
        kick(e.chef, e.counter);
        const p = this.pods[e.chef];
        if (p) { p.chef.chop = 1; this.puff(p, COUNTERS[e.counter], 0xfff3e0, 4, 1.6, 1.0, 4); }
        break;
      }
      case 'pick': case 'place': case 'trash': case 'serve': {
        const p = this.pods[e.chef];
        if (p) p.chef.reach = 1;
        if (e.t !== 'place' && COUNTERS[e.counter]?.type !== 'clear') kick(e.chef, e.counter);
        if (e.t === 'serve' && p) this.puff(p, COUNTERS[e.counter], 0xffd23f, 18, 2.4, 1.3, 2);
        break;
      }
      case 'cooked': { kick(e.chef, e.counter); const p = this.pods[e.chef]; if (p) this.puff(p, COUNTERS[e.counter], 0xffffff, 10, 1.2, 1.3); break; }
      case 'burn': { const p = this.pods[e.chef]; if (p) this.puff(p, COUNTERS[e.counter], 0x222222, 22, 1.6, 1.3); break; }
      case 'deliver': { const p = this.pods[e.chef]; if (p) this.confetti(p); break; }
      case 'sabotaged': if (!e.blocked) this.sabotageFx(e.target, e.card); else { const p = this.pods[e.target]; if (p) { p.flashColor = 0x9bcf53; p.flashT = 1; } } break;
    }
  }

  private confetti(pod: PodView): void {
    const hatch = COUNTERS.find((c) => c.type === 'delivery')!;
    for (const col of [0xff6a3c, 0xffd23f, 0x5ee06a, 0x2f8fe0]) this.puff(pod, hatch, col, 8, 2.8, 1.4, 3);
  }

  private sabotageFx(target: number, card: Card): void {
    const p = this.pods[target];
    if (!p) return;
    p.flashColor = 0xff3355;
    p.flashT = 1;
    const at = (type: Counter['type']): Counter[] => COUNTERS.filter((c) => c.type === type);
    if (card === 'wasabi_bomb') for (const c of [...at('pan'), ...at('cooker')]) this.puff(p, c, 0x7bd23a, 24, 2.6, 1.2, 2);
    if (card === 'dull_knife') for (const c of at('board')) this.puff(p, c, 0xcfd8e3, 14, 2.2, 1.0, 3);
    if (card === 'fish_swap') { const asm = COUNTERS.find((c) => c.x === 4 && c.z === 3)!; this.puff(p, asm, 0xff8a5c, 16, 2, 1.1, 2); }
    if (card === 'order_shuffle') { const hatch = at('delivery')[0]; this.puff(p, hatch, 0xf1e2c2, 20, 2.4, 1.6, 1.5); }
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
    if (p) this.puff(p, COUNTERS[counterIdx], color, n, 2.2);
  }

  private puff(pod: PodView, c: Counter, color: number, n: number, speed = 0.9, y = 1.2, gravity = 0): void {
    const pos = new Float32Array(n * 3), v = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      pos.set([c.x + 0.5 + (Math.random() - 0.5) * 0.3, y, c.z + 0.5 + (Math.random() - 0.5) * 0.3], k * 3);
      v.set([(Math.random() - 0.5) * speed, 0.6 + Math.random() * speed, (Math.random() - 0.5) * speed], k * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: gravity ? 0.08 : 0.14, transparent: true, opacity: 0.9, depthWrite: false }));
    pod.group.add(pts);
    this.particles.push({ p: pts, v, life: 0, max: gravity ? 0.7 : 0.9, gravity });
  }

  render(dt: number): void {
    for (let k = this.particles.length - 1; k >= 0; k--) {
      const q = this.particles[k];
      q.life += dt;
      const a = q.p.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let j = 0; j < a.count; j++) {
        q.v[j * 3 + 1] -= q.gravity * dt;
        a.setXYZ(j, a.getX(j) + q.v[j * 3] * dt, Math.max(0.05, a.getY(j) + q.v[j * 3 + 1] * dt), a.getZ(j) + q.v[j * 3 + 2] * dt);
      }
      a.needsUpdate = true;
      (q.p.material as THREE.PointsMaterial).opacity = Math.max(0, 0.9 * (1 - q.life / q.max));
      if (q.life >= q.max) { q.p.parent?.remove(q.p); q.p.geometry.dispose(); this.particles.splice(k, 1); }
    }
    this.clock += dt;
    for (const [i, p] of this.pods.entries()) p.lanterns.forEach((l, k) => { l.rotation.z = Math.sin(this.clock * 1.3 + k + i) * 0.06; l.rotation.x = Math.sin(this.clock * 0.9 + k * 2) * 0.04; });
    if (this.hintCounter >= 0) {
      this.hintT += dt;
      const o = podOrigin(this.you);
      const c = COUNTERS[this.hintCounter];
      this.hint.position.set(o.x + c.x + 0.5, 1.6 + Math.sin(this.hintT * 5) * 0.1, o.z + c.z + 0.5);
      this.hint.rotation.y += dt * 2;
    }
    // camera: follow your pod, or show the whole market
    const you = this.pods[this.you];
    let target: THREE.Vector3, pos: THREE.Vector3;
    if (this.overview || !you) {
      target = new THREE.Vector3(POD_W + GAP_X / 2, 0, POD_H + GAP_Z / 2 - (this.pods.length <= 2 ? POD_H / 2 + GAP_Z / 2 : 0));
      pos = target.clone().add(new THREE.Vector3(0, 21, 15));
    } else {
      const o = podOrigin(this.you);
      target = new THREE.Vector3(o.x + POD_W / 2 + (you.chef.px - POD_W / 2) * 0.25, 0, o.z + POD_H / 2 + (you.chef.pz - POD_H / 2) * 0.2);
      pos = target.clone().add(new THREE.Vector3(0, 8.4, 6.6));
    }
    const k = Math.min(1, dt * 4);
    this.camTarget.lerp(target, k);
    this.camPos.lerp(pos, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    this.composer.render(dt);
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
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(1.4, 0.35, 1);
  s.renderOrder = 20;
  return s;
}
