import {
  CARD_INFO, CARDS, RECIPES, TICK_HZ, canCast, createState, moveChef, nextStep, step,
  type Card, type Chef, type Hint, type Input, type LogEntry, type SimEvent, type Setup, type State,
} from '@sushi/rules';
import { isMuted, setMuted, sfx } from './audio.ts';
import { Hud } from './hud.ts';
import { CHEF_COLORS, type KitchenScene } from './scene.ts';
import { h, mount, modalOpen } from './ui.ts';

// One shift on screen, whether the sim runs here (solo) or on the server (multiplayer).

export interface ShiftEnd { state: State; log: LogEntry[] }

/** Something that follows the shift as it plays, e.g. the first-shift walkthrough. */
export interface ShiftWatcher {
  events(ev: SimEvent[]): void;
  frame(): void;
  action(what: 'target' | 'view' | 'help'): void;
}

const KEYS_UP = ['KeyW', 'ArrowUp'], KEYS_DOWN = ['KeyS', 'ArrowDown'], KEYS_LEFT = ['KeyA', 'ArrowLeft'], KEYS_RIGHT = ['KeyD', 'ArrowRight'];
const KEYS_ACT = ['KeyE', 'Space', 'KeyJ'], KEYS_CHOP = ['KeyF', 'KeyK'];
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export abstract class Shift {
  state: State | null = null;
  target = -1;
  protected keys = new Set<string>();
  protected lastMove: [number, number] = [0, 0];
  protected hud: HTMLElement;
  private raf = 0;
  private last = performance.now();
  private onKey = (e: KeyboardEvent): void => this.key(e);
  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); this.updateMove(); };
  private onBlur = (): void => { this.keys.clear(); this.updateMove(); };
  ended = false;
  hints = Shift.hintsDefault();
  /** Set by the page: opens the How to play sheet. */
  openHelp: () => void = () => {};
  watcher: ShiftWatcher | null = null;
  /** The walkthrough shows the hint itself and keeps the arrow on. */
  coaching = false;
  /** Solo, unranked: the sim stops while a sheet is open. */
  canPause = false;
  paused = false;
  private ui!: Hud;

  /** Hints are on for your first three shifts, then off unless you turn them on (H). */
  static hintsDefault(): boolean {
    try {
      const pref = localStorage.getItem('sushi.hints');
      if (pref) return pref === 'on';
      return Number(localStorage.getItem('sushi.shifts') ?? 0) < 3;
    } catch { return true; }
  }

  constructor(protected scene: KitchenScene, readonly you: number, protected names: string[], hudRoot: HTMLElement) {
    this.hud = hudRoot;
    scene.build(names, you);
    this.target = names.length > 1 ? (you + 1) % names.length : -1;
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.buildHud();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Send an input change to wherever the sim runs. */
  protected abstract send(inp: Input): void;
  protected abstract tickLocal(dt: number): void;

  stop(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.hud.replaceChildren();
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || modalOpen()) return;
    if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); this.help(); return; }
    if (e.repeat && !KEYS_CHOP.includes(e.code)) { if ([...KEYS_ACT, 'Tab'].includes(e.code)) e.preventDefault(); return; }
    if ([...KEYS_UP, ...KEYS_DOWN, ...KEYS_LEFT, ...KEYS_RIGHT, ...KEYS_ACT, 'Tab'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
    if (KEYS_ACT.includes(e.code)) this.send({ act: true });
    else if (KEYS_CHOP.includes(e.code)) this.send({ chop: true });
    else if (e.code === 'Tab' || e.code === 'KeyQ') this.cycleTarget();
    else if (e.code === 'KeyV') { this.scene.overview = !this.scene.overview; this.watcher?.action('view'); }
    else if (e.code === 'KeyH') this.toggleHints();
    else if (e.code === 'KeyM') { setMuted(!isMuted()); this.ui.syncMute(); }
    else if (/^Digit[1-6]$/.test(e.code)) this.playCard(CARDS[Number(e.code.slice(5)) - 1]);
    this.updateMove();
  }

  private updateMove(): void {
    const has = (ks: string[]): boolean => ks.some((k) => this.keys.has(k));
    const mx = (has(KEYS_RIGHT) ? 1 : 0) - (has(KEYS_LEFT) ? 1 : 0);
    const mz = (has(KEYS_DOWN) ? 1 : 0) - (has(KEYS_UP) ? 1 : 0);
    if (mx !== this.lastMove[0] || mz !== this.lastMove[1]) {
      this.lastMove = [mx, mz];
      this.send({ mx: mx as -1 | 0 | 1, mz: mz as -1 | 0 | 1 });
    }
  }

  /** Touch / on-screen controls. */
  touchMove(mx: number, mz: number): void {
    if (mx !== this.lastMove[0] || mz !== this.lastMove[1]) { this.lastMove = [mx, mz]; this.send({ mx: mx as -1 | 0 | 1, mz: mz as -1 | 0 | 1 }); }
  }
  touchAct(): void { this.send({ act: true }); }
  touchChop(): void { this.send({ chop: true }); }

  cycleTarget(): void {
    const n = this.names.length;
    if (n < 2) return;
    let t = this.target;
    do t = (t + 1) % n; while (t === this.you);
    this.setTarget(t);
  }

  setTarget(i: number): void {
    if (i === this.you || i < 0 || i >= this.names.length) return;
    this.target = i;
    sfx.ui();
    this.watcher?.action('target');
  }

  toggleHints(): void {
    this.hints = !this.hints;
    try { localStorage.setItem('sushi.hints', this.hints ? 'on' : 'off'); } catch { /* private mode */ }
  }

  help(): void {
    this.keys.clear(); this.updateMove();
    this.watcher?.action('help');
    this.openHelp();
  }

  get hintText(): string { return this.hint; }
  /** The hint planner's next step this frame (computed while hints or the walkthrough are on). */
  get nextHint(): Hint | null { return this.hintNow; }
  get isOverview(): boolean { return this.scene.overview; }

  playCard(card: Card): void {
    const s = this.state;
    if (!s) return;
    const target = CARD_INFO[card].self ? this.you : this.target;
    if (!canCast(s, this.you, card, target)) { sfx.wrong(); return; }
    this.send({ card, target });
  }

  /** React to sim events: sounds, particles, toasts. */
  protected events(ev: SimEvent[]): void {
    for (const e of ev) {
      this.scene.onEvent(e);
      const mine = 'chef' in e && e.chef === this.you;
      switch (e.t) {
        case 'chop': if (mine) sfx.chop(); break;
        case 'pick': if (mine) sfx.pick(); break;
        case 'place': if (mine) sfx.place(); break;
        case 'trash': if (mine) sfx.trash(); break;
        case 'cooked': if (mine) sfx.cooked(); break;
        case 'burn': if (mine) { sfx.burn(); this.floatOver('Burnt! −10', 'bad'); } break;
        case 'deliver': if (mine) { sfx.deliver(); this.floatOver(`+${e.points}`, 'good', `${RECIPES[e.recipe].name}${e.tip ? ` · tip ${e.tip}` : ''}`); } break;
        case 'wrong': if (mine) { sfx.wrong(); this.floatOver('Wrong dish −5', 'bad'); } break;
        case 'expire': if (mine) { sfx.wrong(); this.floatOver(`−15`, 'bad', `${RECIPES[e.recipe].name} went cold`); } break;
        case 'order': if (mine) sfx.order(); break;
        case 'cast': if (e.caster === this.you) { sfx.cast(); this.ui.banner(`You played ${CARD_INFO[e.card].name}`, CARD_INFO[e.card].self ? CARD_INFO[e.card].blurb : `on ${this.names[e.target]}. They won’t know it was you.`, 'info'); } break;
        case 'sabotaged':
          if (e.target === this.you) {
            sfx.sabotaged();
            if (e.blocked) this.ui.banner('Shield up!', `Your Bamboo Shield blocked a ${CARD_INFO[e.card].name}.`, 'good');
            else this.ui.banner(`Someone hit you with ${CARD_INFO[e.card].name}!`, e.fizzled ? 'It fizzled: nothing to hit.' : `${CARD_INFO[e.card].blurb} Remember it for Whodunit.`, 'bad');
          }
          break;
      }
    }
    this.watcher?.events(ev);
  }

  private floatOver(text: string, kind: 'good' | 'bad', sub?: string): void {
    const p = this.scene.podScreen(this.you);
    const x = p?.x ?? innerWidth / 2, y = Math.max(140, (p?.y ?? innerHeight / 2) - 40);
    this.ui.float(x, y, text, kind);
    if (sub) this.ui.float(x, y + 34, sub, 'info');
  }

  private frame(t: number): void {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.tickLocal(dt);
    if (this.state) {
      this.scene.sync(this.state, dt);
      const on = (this.hints || this.coaching) && !this.state.over;
      const h = on ? nextStep(this.state, this.you) : null;
      this.scene.setHint(h?.counter ?? -1);
      this.hint = h?.text ?? '';
      this.hintNow = h;
      this.ui.update(this.state, { target: this.target, hint: this.hint, hints: this.hints, coach: this.coaching });
      this.watcher?.frame();
    }
    this.scene.render(dt);
    this.raf = requestAnimationFrame((x) => this.frame(x));
  }

  // ---------- HUD (hud.ts) ----------

  private hint = '';
  private hintNow: Hint | null = null;

  private buildHud(): void {
    this.ui = new Hud({
      you: this.you, names: this.names, colors: this.names.map((_, i) => hex(CHEF_COLORS[i % 4])),
      setTarget: (i) => this.setTarget(i), playCard: (c) => this.playCard(c), help: () => this.help(), toggleHints: () => this.toggleHints(),
    }, touchPad(this));
    mount(this.hud, this.ui.root);
  }
}

function touchPad(g: Shift): HTMLElement {
  if (!matchMedia('(pointer: coarse)').matches && !new URLSearchParams(location.search).has('touch')) return h('div');
  const stick = h('div', { class: 'stick' }, h('i'));
  const knob = stick.firstChild as HTMLElement;
  let id: number | null = null;
  const move = (e: PointerEvent): void => {
    const r = stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dz = e.clientY - (r.top + r.height / 2);
    knob.style.transform = `translate(${Math.max(-30, Math.min(30, dx))}px, ${Math.max(-30, Math.min(30, dz))}px)`;
    g.touchMove(Math.abs(dx) > 14 ? Math.sign(dx) : 0, Math.abs(dz) > 14 ? Math.sign(dz) : 0);
  };
  stick.addEventListener('pointerdown', (e) => { id = e.pointerId; stick.setPointerCapture(e.pointerId); move(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
  const up = (): void => { id = null; knob.style.transform = ''; g.touchMove(0, 0); };
  stick.addEventListener('pointerup', up);
  stick.addEventListener('pointercancel', up);
  document.body.classList.add('touch-ui');
  return h('div', { class: 'touch' }, stick, h('div', { class: 'tbtns' }, h('button', { class: 'tbtn act', 'aria-label': 'Pick up or put down', onpointerdown: () => g.touchAct() }, 'E'), h('button', { class: 'tbtn chop', 'aria-label': 'Chop', onpointerdown: () => g.touchChop() }, 'Chop')));
}

// ---------- solo: the sim runs in this browser ----------

// testing aid: ?debug&speed=10 runs a solo shift faster (the replay check is unaffected)
const params = new URLSearchParams(location.search);
const DEBUG_SPEED = params.has('debug') ? Math.max(1, Math.min(20, Number(params.get('speed') ?? 1))) : 1;

export class SoloShift extends Shift {
  private acc = 0;
  private pending: Input = {};
  readonly log: LogEntry[] = [];

  constructor(scene: KitchenScene, private setup: Setup, hud: HTMLElement, private onEnd: (end: ShiftEnd) => void) {
    super(scene, 0, setup.chefs.map((c) => c.name), hud);
    this.state = createState(setup);
  }

  protected send(inp: Input): void {
    this.pending = { ...this.pending, ...inp, act: this.pending.act || inp.act, chop: this.pending.chop || inp.chop };
  }

  protected tickLocal(dt: number): void {
    const s = this.state!;
    if (s.over) return;
    if (this.paused) return;
    this.acc += dt * DEBUG_SPEED;
    const step_ = 1 / TICK_HZ;
    while (this.acc >= step_ && !s.over) {
      this.acc -= step_;
      const inp = Object.keys(this.pending).length ? this.pending : undefined;
      if (inp) this.log.push({ t: s.tick, c: 0, i: inp });
      this.pending = {};
      this.events(step(s, [inp]));
    }
    if (s.over && !this.ended) {
      this.ended = true;
      try { localStorage.setItem('sushi.shifts', String(Number(localStorage.getItem('sushi.shifts') ?? 0) + 1)); } catch { /* */ }
      this.onEnd({ state: s, log: this.log });
    }
  }
}

// ---------- multiplayer: the server runs the sim; we predict our own chef's movement ----------

export class RoomShift extends Shift {
  private pred: Chef | null = null;
  private acc = 0;
  private serverTick = 0;

  constructor(scene: KitchenScene, you: number, names: string[], hud: HTMLElement, private ws: WebSocket) {
    super(scene, you, names, hud);
  }

  protected send(inp: Input): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'in', i: inp }));
    if (this.pred && (inp.mx !== undefined || inp.mz !== undefined)) {
      if (inp.mx !== undefined) this.pred.mx = inp.mx;
      if (inp.mz !== undefined) this.pred.mz = inp.mz;
    }
  }

  snapshot(s: State, ev: SimEvent[]): void {
    this.state = s;
    this.serverTick = s.tick;
    const me = s.chefs[this.you];
    if (!this.pred) this.pred = { ...me, mx: this.lastMove[0] as -1 | 0 | 1, mz: this.lastMove[1] as -1 | 0 | 1 };
    else {
      const err = Math.hypot(me.x - this.pred.x, me.z - this.pred.z);
      if (err > 1.2) { this.pred.x = me.x; this.pred.z = me.z; }
      else { this.pred.x += (me.x - this.pred.x) * 0.25; this.pred.z += (me.z - this.pred.z) * 0.25; }
      this.pred.slowUntil = me.slowUntil;
    }
    this.events(ev);
  }

  protected tickLocal(dt: number): void {
    if (!this.pred) return;
    this.acc += dt;
    while (this.acc >= 1 / TICK_HZ) { this.acc -= 1 / TICK_HZ; moveChef(this.pred, this.serverTick); }
    this.scene.predicted = { x: this.pred.x, z: this.pred.z };
  }

  override stop(): void { super.stop(); this.scene.predicted = null; }
}
