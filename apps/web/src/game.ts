import {
  CARD_INFO, CARDS, ITEM_LABEL, MISCHIEF_MAX, RECIPES, SHIFT_TICKS, TICK_HZ, canCast, createState, moveChef, nextStep, step,
  type Card, type Chef, type Input, type LogEntry, type SimEvent, type Setup, type State,
} from '@sushi/rules';
import { sfx } from './audio.ts';
import { CHIP, CHIP_LABEL } from './food.ts';
import { CHEF_COLORS, type KitchenScene } from './scene.ts';
import { fmtTime, h, mount, toast } from './ui.ts';

// One shift on screen, whether the sim runs here (solo) or on the server (multiplayer).

export interface ShiftEnd { state: State; log: LogEntry[] }

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

  /** Hints are on for your first three shifts, then off unless you turn them on (H). */
  static hintsDefault(): boolean {
    try {
      const pref = localStorage.getItem('sushi.hints');
      if (pref) return pref === 'on';
      return Number(localStorage.getItem('sushi.shifts') ?? 0) < 3;
    } catch { return true; }
  }

  constructor(protected scene: KitchenScene, protected you: number, protected names: string[], hudRoot: HTMLElement) {
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
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.repeat && !KEYS_CHOP.includes(e.code)) { if ([...KEYS_ACT, 'Tab'].includes(e.code)) e.preventDefault(); return; }
    if ([...KEYS_UP, ...KEYS_DOWN, ...KEYS_LEFT, ...KEYS_RIGHT, ...KEYS_ACT, 'Tab'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
    if (KEYS_ACT.includes(e.code)) this.send({ act: true });
    else if (KEYS_CHOP.includes(e.code)) this.send({ chop: true });
    else if (e.code === 'Tab' || e.code === 'KeyQ') this.cycleTarget();
    else if (e.code === 'KeyV') this.scene.overview = !this.scene.overview;
    else if (e.code === 'KeyH') { this.hints = !this.hints; try { localStorage.setItem('sushi.hints', this.hints ? 'on' : 'off'); } catch { /* */ } this.hudKey = ''; }
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
    this.target = t;
    this.renderHud();
  }

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
        case 'burn': if (mine) { sfx.burn(); toast('Burnt! −10', 'bad'); } break;
        case 'deliver': if (mine) { sfx.deliver(); toast(`${RECIPES[e.recipe].name} +${e.points}${e.tip ? ` (tip ${e.tip})` : ''}`, 'good'); } break;
        case 'wrong': if (mine) { sfx.wrong(); toast('Wrong dish −5', 'bad'); } break;
        case 'expire': if (mine) { sfx.wrong(); toast(`${RECIPES[e.recipe].name} went cold −15`, 'bad'); } break;
        case 'order': if (mine) sfx.order(); break;
        case 'cast': if (e.caster === this.you) { sfx.cast(); toast(`You played ${CARD_INFO[e.card].name}${CARD_INFO[e.card].self ? '' : ` on ${this.names[e.target]}`}`); } break;
        case 'sabotaged':
          if (e.target === this.you) {
            sfx.sabotaged();
            toast(e.blocked ? `Your Bamboo Shield blocked a ${CARD_INFO[e.card].name}!` : `Someone hit you with ${CARD_INFO[e.card].name}!${e.fizzled ? ' (it fizzled)' : ''}`, e.blocked ? 'good' : 'bad');
          }
          break;
      }
    }
  }

  private frame(t: number): void {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.tickLocal(dt);
    if (this.state) {
      this.scene.sync(this.state, dt);
      const h = this.hints && !this.state.over ? nextStep(this.state, this.you) : null;
      this.scene.setHint(h?.counter ?? -1);
      this.hintText = h?.text ?? '';
      this.renderHud();
    }
    this.scene.render(dt);
    this.raf = requestAnimationFrame((x) => this.frame(x));
  }

  // ---------- HUD ----------

  private el: Record<string, HTMLElement> = {};
  private hudKey = '';
  private hintText = '';

  private buildHud(): void {
    this.el.orders = h('div', { class: 'orders' });
    this.el.top = h('div', { class: 'topbar' });
    this.el.rivals = h('div', { class: 'rivals' });
    this.el.cards = h('div', { class: 'cards' });
    this.el.held = h('div', { class: 'held' });
    this.el.help = h('div', { class: 'keys' }, 'WASD move · E pick/place · F chop · 1–6 cards · Tab target · V view all · H hints');
    this.el.hint = h('div', { class: 'hint' });
    mount(this.hud, this.el.hint, this.el.orders, this.el.top, this.el.rivals, this.el.cards, this.el.held, this.el.help, touchPad(this));
  }

  private renderHud(): void {
    const s = this.state!;
    const me = s.chefs[this.you];
    const left = SHIFT_TICKS - s.tick;
    // cheap change detection: only rebuild when something visible changed
    const key = JSON.stringify([this.hintText, this.hints, Math.ceil(left / 20), me.score, me.streak, me.mischief, me.loadout, me.orders.map((o) => [o.id, Math.ceil((o.due - s.tick) / 20)]), s.chefs.map((c) => c.score), this.target, me.held, me.shield, s.tick < me.cdUntil, s.tick < me.slowUntil, s.tick < me.dullUntil]);
    if (key === this.hudKey) return;
    this.hudKey = key;

    this.el.top.replaceChildren(...[
      h('div', { class: `clock ${left < 20 * 20 ? 'hurry' : ''}` }, fmtTime(left)),
      h('div', { class: 'score' }, h('b', {}, String(me.score)), h('span', {}, ' pts')),
      me.streak >= 3 ? h('div', { class: 'streak' }, `streak ×${me.streak}`) : null,
      me.shield ? h('div', { class: 'status good' }, '🛡 shield') : null,
      s.tick < me.slowUntil ? h('div', { class: 'status bad' }, 'soy slick') : null,
      s.tick < me.dullUntil ? h('div', { class: 'status bad' }, 'dull knife') : null,
    ].filter((x): x is HTMLDivElement => !!x));

    this.el.orders.replaceChildren(...me.orders.map((o) => {
      const r = RECIPES[o.recipe];
      const frac = Math.max(0, (o.due - s.tick) / (o.due - o.born));
      return h('div', { class: `order ${frac < 0.25 ? 'late' : ''}` },
        h('div', { class: 'oname' }, r.name),
        h('div', { class: 'chips' }, ...r.ingredients.map((k) => h('span', { class: 'chip', style: `--c:${CHIP[k]}` }, CHIP_LABEL[k]))),
        h('div', { class: 'patience' }, h('i', { style: `width:${(frac * 100).toFixed(0)}%` })));
    }));

    this.el.rivals.replaceChildren(...s.chefs.map((c, i) => h('div', { class: `rival ${i === this.you ? 'you' : ''} ${i === this.target ? 'target' : ''}`, style: `--c:${hex(CHEF_COLORS[i % 4])}`, onclick: () => { if (i !== this.you) { this.target = i; this.renderHud(); } } },
      h('span', { class: 'dot' }), h('span', { class: 'rname' }, c.name), h('b', {}, String(c.score)), i === this.target ? h('em', {}, 'target') : null)));

    const cooling = s.tick < me.cdUntil;
    this.el.cards.replaceChildren(
      h('div', { class: 'mischief' }, h('span', {}, 'Mischief'), ...Array.from({ length: MISCHIEF_MAX }, (_, k) => h('i', { class: k < me.mischief ? 'on' : '' }))),
      ...CARDS.map((card, k) => {
        const info = CARD_INFO[card];
        const t = info.self ? this.you : this.target;
        const ok = canCast(s, this.you, card, t);
        const owned = me.loadout[card] ?? 0;
        return h('button', { class: `card ${ok ? 'ok' : ''} ${cooling ? 'cool' : ''}`, title: info.blurb, onclick: () => this.playCard(card) },
          h('kbd', {}, String(k + 1)), h('b', {}, info.name), h('small', {}, owned ? `${owned} owned` : `${info.cost} mischief`));
      }),
    );
    this.el.hint.textContent = this.hints && this.hintText ? `Next: ${this.hintText}` : '';
    this.el.held.textContent = me.held ? `Holding: ${me.held.k === 'plate' ? `plate${me.held.on?.length ? ` (${me.held.on.map((k) => CHIP_LABEL[k] ?? k).join(', ')})` : ''}` : ITEM_LABEL[me.held.k]}` : '';
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
  stick.addEventListener('pointerup', () => { id = null; knob.style.transform = ''; g.touchMove(0, 0); });
  return h('div', { class: 'touch' }, stick, h('button', { class: 'tbtn act', onpointerdown: () => g.touchAct() }, 'E'), h('button', { class: 'tbtn chop', onpointerdown: () => g.touchChop() }, 'Chop'));
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
