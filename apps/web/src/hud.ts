import { CARD_COOLDOWN, CARD_INFO, CARDS, ITEM_LABEL, MISCHIEF_MAX, RECIPES, SHIFT_TICKS, canCast, type Card, type State } from '@sushi/rules';
import { isMuted, setMuted } from './audio.ts';
import { CHIP, CHIP_LABEL } from './food.ts';
import { h } from './ui.ts';

// The in-shift HUD. Built once per shift, then updated in place every frame (only what changed is
// touched), so CSS transitions and animations keep running. Everything sits on the screen edges:
// the camera keeps your stall in the middle.

export interface HudHooks {
  you: number;
  names: string[];
  colors: string[];
  setTarget: (i: number) => void;
  playCard: (c: Card) => void;
  help: () => void;
  toggleHints: () => void;
}

export interface HudView { target: number; hint: string; hints: boolean; coach: boolean }

/** Clicking a HUD button must not leave it focused: Space and E are game keys. */
const tap = (fn: () => void) => (e: Event): void => { (e.currentTarget as HTMLElement).blur(); fn(); };
const secs = (ticks: number): number => Math.max(0, Math.ceil(ticks / 20));
const SHORT: Record<Card, string> = { wasabi_bomb: 'Wasabi', fish_swap: 'Swap', dull_knife: 'Dull', soy_slick: 'Slick', order_shuffle: 'Shuffle', bamboo_shield: 'Shield' };

interface Ticket { el: HTMLElement; bar: HTMLElement; left: HTMLElement; w: string; cls: string; s: number }

export class Hud {
  readonly root: HTMLElement;
  private orders = h('div', { class: 'h-orders', 'data-tour': 'orders', 'aria-label': 'Orders' });
  private tickets = new Map<number, Ticket>();
  private clock = h('div', { class: 'h-clock', role: 'timer' });
  private board = h('div', { class: 'h-board', 'data-tour': 'board' });
  private rows: { el: HTMLElement; score: HTMLElement; tag: HTMLElement }[] = [];
  private hand = h('div', { class: 'h-hand', 'data-tour': 'hand' });
  private meter = h('div', { class: 'h-meter', title: 'Mischief: every dish you serve lights one pip. Cards spend them.' });
  private pips: HTMLElement[] = [];
  private cardEls: { el: HTMLElement; sub: HTMLElement }[] = [];
  private targetEl = h('span', { class: 'h-target' });
  private cdEl = h('span', { class: 'h-cd' });
  private held = h('div', { class: 'h-held' });
  private status = h('div', { class: 'h-status' });
  private hintEl = h('div', { class: 'h-hint', 'aria-live': 'polite' });
  private bannerEl = h('div', { class: 'h-banner' });
  private fx = h('div', { class: 'h-fx' });
  private hintBtn: HTMLElement;
  private muteBtn: HTMLElement;
  private last: Record<string, string> = {};
  private scores: number[] = [];
  private bannerT = 0;

  constructor(private o: HudHooks, extra: HTMLElement) {
    this.hintBtn = h('button', { class: 'h-btn', title: 'Hints on/off (H)', 'aria-label': 'Toggle hints', onclick: tap(o.toggleHints) }, '💡');
    this.muteBtn = h('button', { class: 'h-btn', title: 'Sound on/off (M)', 'aria-label': 'Toggle sound', onclick: tap(() => this.toggleMute()) }, isMuted() ? '🔇' : '🔊');
    const buttons = h('div', { class: 'h-btns' },
      h('button', { class: 'h-btn', title: 'How to play (?)', 'aria-label': 'How to play', 'data-tour': 'help', onclick: tap(o.help) }, '?'),
      this.hintBtn, this.muteBtn);
    o.names.forEach((n, i) => {
      const score = h('b', {}, '0');
      const tag = h('em', {});
      const el = h('button', { class: `h-row${i === o.you ? ' you' : ''}`, style: `--c:${o.colors[i]}`, title: i === o.you ? 'You' : `Target ${n} (Tab cycles)`, onclick: tap(() => { if (i !== o.you) o.setTarget(i); }) },
        h('span', { class: 'dot' }), h('span', { class: 'rname' }, i === o.you ? `${n} (you)` : n), tag, score);
      this.rows.push({ el, score, tag });
      this.board.append(el);
    });
    for (let k = 0; k < MISCHIEF_MAX; k++) this.pips.push(h('i'));
    this.meter.append(h('span', { class: 'h-label' }, 'Mischief'), h('span', { class: 'pips' }, ...this.pips));
    const cards = h('div', { class: 'h-cards' }, ...CARDS.map((card, k) => {
      const info = CARD_INFO[card];
      const sub = h('small', {});
      const el = h('button', { class: `h-card${info.self ? ' self' : ''}`, title: `${info.name}: ${info.blurb}`, onclick: tap(() => o.playCard(card)) },
        h('kbd', {}, String(k + 1)), h('b', { class: 'long' }, info.name), h('b', { class: 'short' }, SHORT[card]),
        h('span', { class: 'cost', 'aria-label': `costs ${info.cost}` }, ...Array.from({ length: info.cost }, () => h('i'))), sub);
      this.cardEls.push({ el, sub });
      return el;
    }));
    this.hand.append(h('div', { class: 'h-handtop' }, this.meter, h('span', { class: 'h-aim' }, '🎯 ', this.targetEl, h('kbd', {}, 'Tab')), this.cdEl), cards);
    this.root = h('div', { class: 'hud-root' },
      this.orders,
      h('div', { class: 'h-tr' }, h('div', { class: 'h-top' }, this.clock, buttons), this.board),
      this.hintEl,
      h('div', { class: 'h-bl' }, this.status, this.held),
      this.hand, this.bannerEl, this.fx, extra);
  }

  private toggleMute(): void {
    setMuted(!isMuted());
    this.muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  }
  syncMute(): void { this.muteBtn.textContent = isMuted() ? '🔇' : '🔊'; }

  /** Set text/class only when it changed. */
  private put(key: string, value: string, apply: () => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply();
  }

  update(s: State, v: HudView): void {
    const me = s.chefs[this.o.you];
    const left = SHIFT_TICKS - s.tick;
    const sl = secs(left);
    this.put('clock', `${sl}`, () => {
      this.clock.textContent = `${Math.floor(sl / 60)}:${String(sl % 60).padStart(2, '0')}`;
      this.clock.classList.toggle('hurry', sl <= 20);
      this.clock.classList.toggle('tock', sl <= 20 && sl % 2 === 0);
    });

    // orders: keyed by id so a ticket keeps its element (and its slide-in) for its whole life
    const live = new Set(me.orders.map((o) => o.id));
    for (const [id, t] of this.tickets) if (!live.has(id)) { this.tickets.delete(id); t.el.classList.add('gone'); setTimeout(() => t.el.remove(), 260); }
    for (const o of me.orders) {
      let t = this.tickets.get(o.id);
      if (!t) {
        const r = RECIPES[o.recipe];
        const bar = h('i');
        const leftEl = h('span', { class: 't-left' });
        const el = h('div', { class: 'ticket' },
          h('div', { class: 't-head' }, h('b', {}, r.name), leftEl),
          h('div', { class: 'chips' }, ...r.ingredients.map((k) => h('span', { class: 'chip', style: `--c:${CHIP[k]}` }, CHIP_LABEL[k]))),
          h('div', { class: 'patience' }, bar));
        t = { el, bar, left: leftEl, w: '', cls: '', s: -1 };
        this.tickets.set(o.id, t);
        this.orders.append(el);
      }
      const frac = Math.max(0, (o.due - s.tick) / (o.due - o.born));
      const w = `${(frac * 100).toFixed(1)}%`;
      if (w !== t.w) { t.w = w; t.bar.style.width = w; }
      const cls = frac < 0.25 ? 'late' : frac < 0.5 ? 'warn' : '';
      if (cls !== t.cls) { t.el.classList.remove('late', 'warn'); if (cls) t.el.classList.add(cls); t.cls = cls; }
      const ss = secs(o.due - s.tick);
      if (ss !== t.s) { t.s = ss; t.left.textContent = `${ss}s`; }
    }
    this.put('noorders', String(me.orders.length === 0), () => this.orders.classList.toggle('empty', me.orders.length === 0));

    // scoreboard + score pops
    const order = s.chefs.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score);
    this.put('rank', order.map((x) => x.i).join(','), () => order.forEach(({ i }, k) => { this.rows[i].el.style.order = String(k); }));
    s.chefs.forEach((c, i) => {
      const row = this.rows[i];
      if (!row) return;
      const prev = this.scores[i];
      if (prev !== undefined && prev !== c.score) this.rowPop(i, c.score - prev);
      this.scores[i] = c.score;
      this.put(`s${i}`, String(c.score), () => { row.score.textContent = String(c.score); });
      this.put(`t${i}`, String(i === v.target), () => { row.el.classList.toggle('target', i === v.target); row.tag.textContent = i === v.target ? 'target' : ''; });
    });

    // hand
    const cooling = s.tick < me.cdUntil;
    this.put('mis', String(me.mischief), () => {
      this.pips.forEach((p, k) => p.classList.toggle('on', k < me.mischief));
      this.meter.classList.toggle('charged', me.mischief > 0);
      this.meter.classList.toggle('full', me.mischief >= MISCHIEF_MAX);
    });
    this.put('aim', String(v.target), () => { this.targetEl.textContent = this.o.names[v.target] ?? 'nobody'; this.targetEl.style.color = this.o.colors[v.target] ?? ''; });
    this.put('cd', cooling ? String(secs(me.cdUntil - s.tick)) : '', () => {
      this.cdEl.textContent = cooling ? `cooldown ${secs(me.cdUntil - s.tick)}s` : '';
      this.cdEl.style.setProperty('--p', cooling ? String((me.cdUntil - s.tick) / CARD_COOLDOWN) : '0');
    });
    CARDS.forEach((card, k) => {
      const info = CARD_INFO[card];
      const ok = canCast(s, this.o.you, card, info.self ? this.o.you : v.target);
      const owned = me.loadout[card] ?? 0;
      const c = this.cardEls[k];
      this.put(`c${k}`, `${ok}|${cooling}|${owned}|${me.shield}`, () => {
        c.el.classList.toggle('ok', ok);
        c.el.classList.toggle('cool', cooling);
        c.el.setAttribute('aria-disabled', String(!ok));
        c.sub.textContent = owned ? `×${owned} owned` : info.self && me.shield ? 'active' : '';
      });
    });

    // what you hold, and what's been done to you
    const held = me.held ? (me.held.k === 'plate' ? `🍽 Plate${me.held.on?.length ? `: ${me.held.on.map((k) => CHIP_LABEL[k] ?? k).join(' + ')}` : ' (empty)'}` : `✋ ${ITEM_LABEL[me.held.k]}`) : '';
    this.put('held', held, () => { this.held.textContent = held; this.held.classList.toggle('on', !!held); });
    const fx: [string, string, string][] = [];
    if (me.shield) fx.push(['good', '🛡', 'Shield up']);
    if (s.tick < me.slowUntil) fx.push(['bad', '🫗', `Soy slick ${secs(me.slowUntil - s.tick)}s`]);
    if (s.tick < me.dullUntil) fx.push(['bad', '🔪', `Dull knife ${secs(me.dullUntil - s.tick)}s`]);
    if (me.streak >= 3) fx.push(['hot', '🔥', `Streak ×${me.streak}`]);
    this.put('fx', JSON.stringify(fx), () => this.status.replaceChildren(...fx.map(([c, i, t]) => h('span', { class: `fxchip ${c}` }, h('span', { 'aria-hidden': 'true' }, i), ` ${t}`))));

    const hint = v.hints && !v.coach && v.hint ? v.hint : '';
    this.put('hint', hint, () => { this.hintEl.replaceChildren(...(hint ? [h('small', {}, 'Next'), hint] : [])); });
    this.put('hints', String(v.hints), () => { this.hintBtn.classList.toggle('on', v.hints); });
  }

  private rowPop(i: number, d: number): void {
    const row = this.rows[i]?.el;
    if (!row) return;
    const p = h('span', { class: `rowpop ${d > 0 ? 'good' : 'bad'}` }, d > 0 ? `+${d}` : String(d));
    row.append(p);
    row.classList.remove('bump'); void row.offsetWidth; row.classList.add('bump');
    setTimeout(() => p.remove(), 1100);
  }

  /** A big floating number, e.g. over your stall when you serve. */
  float(x: number, y: number, text: string, kind: 'good' | 'bad' | 'info' = 'good'): void {
    const p = h('div', { class: `float ${kind}`, style: `left:${x}px;top:${y}px` }, text);
    this.fx.append(p);
    setTimeout(() => p.remove(), 1400);
  }

  /** A banner across the middle: "Someone hit you with Wasabi Bomb!" */
  banner(title: string, sub: string, kind: 'bad' | 'good' | 'info' = 'bad'): void {
    clearTimeout(this.bannerT);
    this.bannerEl.className = `h-banner ${kind}`;
    this.bannerEl.replaceChildren(h('b', {}, title), sub ? h('small', {}, sub) : '');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('show');
    this.bannerT = window.setTimeout(() => this.bannerEl.classList.remove('show'), 2400);
  }
}
