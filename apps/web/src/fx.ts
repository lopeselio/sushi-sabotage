import * as THREE from 'three';

// Scene effects: pooled particles, floating score pops and procedural canvas textures.
// Nothing here allocates per frame; emitters write into fixed ring buffers.

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha > 0.0 ? aSize * uScale / -mv.z : 0.0;
  vAlpha = aAlpha;
  vColor = aColor;
}`;

const FRAG = /* glsl */ `
uniform float uHard;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  // soft round puffs, or crisp chips (confetti, sparks) when uHard is 1
  float soft = smoothstep(0.5, 0.0, d);
  float hard = 1.0 - smoothstep(0.36, 0.5, max(abs(c.x), abs(c.y)) * (1.0 + 0.4 * abs(c.x - c.y)));
  float a = mix(soft * soft, hard, uHard) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface EmitOpts {
  /** spread of the start position */
  spread?: number;
  /** speed: horizontal spread and vertical kick */
  speed?: number;
  up?: number;
  size?: number;
  life?: number;
  gravity?: number;
  /** velocity damping per second (0 = none) */
  drag?: number;
  /** size growth per second (smoke billows) */
  grow?: number;
  alpha?: number;
}

/** A fixed pool of point particles in world space. */
export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly misc: Float32Array; // gravity, drag, grow, a0
  private next = 0;
  private live = 0;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tmp = new THREE.Color();

  constructor(max: number, additive: boolean, hard = false) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.span = new Float32Array(max);
    this.misc = new Float32Array(max * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 400 }, uHard: { value: hard ? 1 : 0 } },
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  /** Pixel scale for world-sized points: drawing-buffer height / (2 tan(fov/2)). */
  setScale(s: number): void { this.mat.uniforms.uScale.value = s; }

  emit(x: number, y: number, z: number, color: number, n: number, o: EmitOpts = {}): void {
    const spread = o.spread ?? 0.15, speed = o.speed ?? 0.5, up = o.up ?? 0.6, size = o.size ?? 0.12, life = o.life ?? 0.9;
    this.tmp.setHex(color);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const j = i * 3;
      this.pos[j] = x + (Math.random() - 0.5) * spread * 2;
      this.pos[j + 1] = y + (Math.random() - 0.5) * spread * 0.5;
      this.pos[j + 2] = z + (Math.random() - 0.5) * spread * 2;
      const a = Math.random() * Math.PI * 2, r = Math.random() * speed;
      this.vel[j] = Math.cos(a) * r;
      this.vel[j + 1] = up * (0.5 + Math.random() * 0.8);
      this.vel[j + 2] = Math.sin(a) * r;
      // slight colour jitter keeps bursts lively
      const v = 0.88 + Math.random() * 0.24;
      this.col[j] = Math.min(1, this.tmp.r * v);
      this.col[j + 1] = Math.min(1, this.tmp.g * v);
      this.col[j + 2] = Math.min(1, this.tmp.b * v);
      this.size[i] = size * (0.7 + Math.random() * 0.6);
      this.life[i] = 0;
      this.span[i] = life * (0.75 + Math.random() * 0.5);
      const m = i * 4;
      this.misc[m] = o.gravity ?? 0;
      this.misc[m + 1] = o.drag ?? 0;
      this.misc[m + 2] = o.grow ?? 0;
      this.misc[m + 3] = o.alpha ?? 0.9;
      this.alpha[i] = this.misc[m + 3];
    }
    this.live = Math.min(this.max, this.live + n);
  }

  update(dt: number): void {
    if (this.live === 0) return;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.alpha[i] <= 0) continue;
      const t = (this.life[i] += dt);
      const span = this.span[i];
      if (t >= span) { this.alpha[i] = 0; continue; }
      alive++;
      const j = i * 3, m = i * 4;
      const drag = 1 - Math.min(1, this.misc[m + 1] * dt);
      this.vel[j] *= drag; this.vel[j + 2] *= drag;
      this.vel[j + 1] = this.vel[j + 1] * drag - this.misc[m] * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] = Math.max(0.03, this.pos[j + 1] + this.vel[j + 1] * dt);
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] += this.misc[m + 2] * dt;
      // fade in fast, out slowly
      const u = t / span;
      this.alpha[i] = this.misc[m + 3] * Math.min(1, u * 8) * (1 - u * u);
    }
    this.live = alive;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
  }
}

/** Floating text ("+42", "Burnt!") that pops up and drifts away. A small pool of canvas sprites. */
export class Pops {
  readonly group = new THREE.Group();
  private items: { s: THREE.Sprite; c: HTMLCanvasElement; tex: THREE.CanvasTexture; t: number; x: number; y: number; z: number }[] = [];
  private next = 0;

  constructor(n = 6) {
    for (let k = 0; k < n; k++) {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 120;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 30;
      this.group.add(s);
      this.items.push({ s, c, tex, t: 1, x: 0, y: 0, z: 0 });
    }
  }

  show(text: string, color: string, x: number, y: number, z: number, sub = ''): void {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    const g = it.c.getContext('2d')!;
    g.clearRect(0, 0, 320, 120);
    g.textAlign = 'center';
    g.lineJoin = 'round';
    g.font = `400 ${sub ? 58 : 64}px "Dela Gothic One", system-ui, sans-serif`;
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(20,10,20,0.9)';
    const ty = sub ? 64 : 82;
    g.strokeText(text, 160, ty);
    g.fillStyle = color;
    g.fillText(text, 160, ty);
    if (sub) {
      g.font = '700 28px system-ui, sans-serif';
      g.lineWidth = 7;
      g.strokeText(sub, 160, 104);
      g.fillStyle = '#fff4d6';
      g.fillText(sub, 160, 104);
    }
    it.tex.needsUpdate = true;
    it.t = 0;
    it.x = x; it.y = y; it.z = z;
    it.s.visible = true;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (!it.s.visible) continue;
      it.t += dt / 1.4;
      if (it.t >= 1) { it.s.visible = false; continue; }
      const t = it.t;
      // spring in, hold, rise and fade
      const pop = t < 0.15 ? t / 0.15 * 1.25 : t < 0.25 ? 1.25 - (t - 0.15) * 2.5 : 1;
      it.s.position.set(it.x, it.y + t * 1.1, it.z);
      it.s.scale.set(1.9 * pop, 0.71 * pop, 1);
      (it.s.material as THREE.SpriteMaterial).opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    }
  }
}

// ---------- procedural textures ----------

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** A soft dark blob for cheap contact shadows. */
export function blobTexture(): THREE.Texture {
  const [c, g] = canvas(64, 64);
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,0.75)');
  r.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Wet cobblestones: a colour map and a roughness map with puddles. Seeded so it's the same every load. */
export function streetTextures(): { map: THREE.Texture; rough: THREE.Texture } {
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const N = 512;
  const [c, g] = canvas(N, N);
  const [rc, rg] = canvas(N, N);
  g.fillStyle = '#0d0b12';
  g.fillRect(0, 0, N, N);
  rg.fillStyle = '#9a9a9a';
  rg.fillRect(0, 0, N, N);
  const rows = 12, row = N / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -row * 0.5 : 0;
    while (x < N) {
      const w = row * (0.9 + rnd() * 0.7);
      const l = 20 + rnd() * 16, hue = 250 + rnd() * 40;
      const draw = (ctx: CanvasRenderingContext2D, fill: string): void => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(x + 3, r * row + 3, w - 6, row - 6, 9);
        ctx.fill();
      };
      draw(g, `hsl(${hue} 12% ${l}%)`);
      draw(rg, `rgb(${120 + rnd() * 60 | 0},${120 + rnd() * 60 | 0},${120 + rnd() * 60 | 0})`);
      // the wrap-around copy keeps the tile seamless
      if (x + w > N) { x -= N; draw(g, `hsl(${hue} 12% ${l}%)`); draw(rg, '#a0a0a0'); x += N; }
      x += w;
    }
  }
  // puddles: glossy and slightly darker
  for (let k = 0; k < 7; k++) {
    const px = rnd() * N, py = rnd() * N, pr = 30 + rnd() * 60;
    for (const [ctx, col] of [[g, 'rgba(8,6,14,0.45)'], [rg, 'rgba(15,15,15,0.85)']] as const) {
      for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
        const grd = ctx.createRadialGradient(px + dx, py + dy, 0, px + dx, py + dy, pr);
        grd.addColorStop(0, col);
        grd.addColorStop(0.7, col);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.ellipse(px + dx, py + dy, pr * 1.4, pr, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(rc);
  for (const t of [map, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  return { map, rough };
}

/** Warm wooden floor boards for the stall floor. */
export function floorTexture(): THREE.Texture {
  let seed = 777;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const [c, g] = canvas(256, 256);
  const boards = 8, bw = 256 / boards;
  for (let b = 0; b < boards; b++) {
    let y = -rnd() * 128;
    while (y < 256) {
      const len = 90 + rnd() * 120;
      const l = 30 + rnd() * 10;
      g.fillStyle = `hsl(${24 + rnd() * 8} 42% ${l}%)`;
      g.fillRect(b * bw + 1, y + 1, bw - 2, len - 2);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let k = 0; k < 3; k++) g.fillRect(b * bw + 4 + rnd() * (bw - 8), y + 4, 1, len - 8);
      y += len;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** The stall's name painted on its signboard. */
export function signTexture(name: string, color: number): THREE.CanvasTexture {
  const [c] = canvas(512, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (): void => {
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 512, 128);
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    const text = name || 'Sushi';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 70;
    g.font = `400 ${size}px "Dela Gothic One", system-ui, sans-serif`;
    while (g.measureText(text).width > 440 && size > 30) { size -= 4; g.font = `400 ${size}px "Dela Gothic One", system-ui, sans-serif`; }
    g.shadowColor = hex;
    g.shadowBlur = 18;
    g.fillStyle = '#fff1d6';
    g.fillText(text, 256, 66);
    g.shadowBlur = 0;
    g.fillStyle = hex;
    g.fillRect(156, 108, 200, 6);
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.ready.then(draw).catch(() => { /* keep the fallback font */ });
  return tex;
}
