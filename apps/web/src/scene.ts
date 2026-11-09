import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { COUNTERS, POD_H, POD_W, facingCounter, stationProgress, type Chef, type Counter, type State } from '@sushi/rules';
import { itemObject, keyOf } from './food.ts';

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

interface Slot { key: string; obj: THREE.Object3D | null; bar: THREE.Group; fill: THREE.Mesh }
interface ChefView { root: THREE.Object3D; body: THREE.Object3D; heldKey: string; held: THREE.Object3D | null; label: THREE.Sprite; px: number; pz: number; bob: number }
interface PodView { group: THREE.Group; slots: Slot[]; chef: ChefView; plates: THREE.Object3D[]; flash: THREE.Mesh; flashT: number; select: THREE.Mesh; containerIcons: THREE.Object3D[] }
interface Particle { p: THREE.Points; v: Float32Array; life: number; max: number }

export class KitchenScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private composer: EffectComposer;
  private models = new Map<string, THREE.Object3D>();
  private pods: PodView[] = [];
  private particles: Particle[] = [];
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
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(0x120d1c);
    this.scene.fog = new THREE.Fog(0x120d1c, 18, 48);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.6, 0.82));
    this.composer.addPass(new OutputPass());
    this.lights();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const names = ['chef', 'counter', 'board', 'cooker', 'pan', 'pot', 'plates', 'delivery', 'trash', 'container', 'lantern', 'noren'];
    await Promise.all(names.map(async (n) => {
      const g = await loader.loadAsync(`/models/${n}.glb`);
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.models.set(n, g.scene);
    }));
  }

  private lights(): void {
    this.scene.add(new THREE.HemisphereLight(0x8a7fc0, 0x1a1020, 0.55));
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
    const containerIcons: THREE.Object3D[] = [];
    for (const c of COUNTERS) {
      const m = this.model(MODEL_FOR[c.type]);
      m.position.set(c.x + 0.5, 0, c.z + 0.5);
      m.rotation.y = counterYaw(c);
      group.add(m);
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
      slots.push({ key: '', obj: null, bar, fill });
    }
    // lanterns and a noren curtain at the front of the stall
    for (const x of [1.5, POD_W - 1.5]) {
      const l = this.model('lantern');
      l.position.set(x, 2.6, POD_H + 0.4);
      group.add(l);
    }
    const lamp = new THREE.PointLight(0xffa860, 14, 9, 1.6);
    lamp.position.set(POD_W / 2, 3.2, POD_H / 2 + 1);
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
    return { group, slots, plates, flash, flashT: 0, select, containerIcons, chef: { root, body, heldKey: '', held: null, label, px: 4.5, pz: 4.5, bob: 0 } };
  }

  /** Push a sim state into the scene (called every frame with the latest state). */
  sync(s: State, dt: number): void {
    s.chefs.forEach((c, i) => {
      const pod = this.pods[i];
      if (!pod) return;
      this.syncChef(pod, c, i, dt);
      COUNTERS.forEach((counter, idx) => this.syncSlot(pod, c, counter, idx, s.tick));
      pod.plates.forEach((p, k) => { p.visible = k < c.plates; });
      if (pod.flashT > 0) {
        pod.flashT = Math.max(0, pod.flashT - dt);
        (pod.flash.material as THREE.MeshBasicMaterial).opacity = pod.flashT * 0.8;
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
    ch.bob = moving ? ch.bob + dt * 14 : ch.bob * 0.8;
    ch.body.position.y = Math.abs(Math.sin(ch.bob)) * 0.06;
    ch.body.rotation.z = Math.sin(ch.bob) * 0.06;
    const key = c.held ? keyOf(c.held) : '';
    if (key !== ch.heldKey) {
      if (ch.held) ch.root.remove(ch.held);
      ch.held = c.held ? itemObject(c.held) : null;
      if (ch.held) { ch.held.position.set(0, 0.7, 0.42); ch.root.add(ch.held); }
      ch.heldKey = key;
    }
    ch.label.lookAt(this.camera.position);
  }

  private syncSlot(pod: PodView, c: Chef, counter: Counter, idx: number, tick: number): void {
    const slot = pod.slots[idx];
    const it = c.st[idx].item;
    const key = it ? keyOf(it) : '';
    if (key !== slot.key) {
      if (slot.obj) pod.group.remove(slot.obj);
      slot.obj = it ? itemObject(it) : null;
      if (slot.obj) {
        const y = counter.type === 'cooker' ? 1.33 : counter.type === 'pan' ? 1.04 : counter.type === 'pot' ? 1.3 : 0.92;
        slot.obj.position.set(counter.x + 0.5, y, counter.z + 0.5);
        pod.group.add(slot.obj);
      }
      slot.key = key;
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
      if (prog.burning && prog.p > 0.5 && tick % 6 === 0) this.puff(pod, counter, 0x555555, 4);
    }
    if (counter.type === 'pot' && it && tick % 10 === 0) this.puff(pod, counter, 0xdddddd, 2);
  }

  // ---------- effects ----------

  flashPod(i: number): void { const p = this.pods[i]; if (p) p.flashT = 1; }

  burst(i: number, counterIdx: number, color: number, n = 10): void {
    const p = this.pods[i];
    if (p) this.puff(p, COUNTERS[counterIdx], color, n, 2.2);
  }

  private puff(pod: PodView, c: Counter, color: number, n: number, speed = 0.9): void {
    const pos = new Float32Array(n * 3), v = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      pos.set([c.x + 0.5 + (Math.random() - 0.5) * 0.3, 1.2, c.z + 0.5 + (Math.random() - 0.5) * 0.3], k * 3);
      v.set([(Math.random() - 0.5) * speed, 0.6 + Math.random() * speed, (Math.random() - 0.5) * speed], k * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 0.14, transparent: true, opacity: 0.9, depthWrite: false }));
    pod.group.add(pts);
    this.particles.push({ p: pts, v, life: 0, max: 0.9 });
  }

  render(dt: number): void {
    for (let k = this.particles.length - 1; k >= 0; k--) {
      const q = this.particles[k];
      q.life += dt;
      const a = q.p.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let j = 0; j < a.count; j++) {
        a.setXYZ(j, a.getX(j) + q.v[j * 3] * dt, a.getY(j) + q.v[j * 3 + 1] * dt, a.getZ(j) + q.v[j * 3 + 2] * dt);
      }
      a.needsUpdate = true;
      (q.p.material as THREE.PointsMaterial).opacity = Math.max(0, 0.9 * (1 - q.life / q.max));
      if (q.life >= q.max) { q.p.parent?.remove(q.p); q.p.geometry.dispose(); this.particles.splice(k, 1); }
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
      pos = target.clone().add(new THREE.Vector3(0, 10.5, 8));
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
