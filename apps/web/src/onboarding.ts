import { CARD_INFO, CARDS, COUNTERS, RECIPES, SCORE, SPAWN, isHeat, type SimEvent } from '@sushi/rules';
import { sfx } from './audio.ts';
import { CHIP, CHIP_LABEL } from './food.ts';
import type { Shift, ShiftWatcher } from './game.ts';
import { h, openModal, saved } from './ui.ts';

// First-run experience: welcome cards on the first visit, a hands-on walkthrough in your first solo
// shift that waits for you to actually do each thing, and a How to play sheet that's always one
// click (or "?") away. What you've seen is remembered in this browser.

export const KEYS = { onboarded: 'sushi.onboarded', tutorialDone: 'sushi.tutorialDone' } as const;
export const onboarded = (): boolean => saved.get(KEYS.onboarded) === '1';
export const tutorialDone = (): boolean => saved.get(KEYS.tutorialDone) === '1';
export const markOnboarded = (): void => saved.set(KEYS.onboarded, '1');
export const markTutorialDone = (): void => saved.set(KEYS.tutorialDone, '1');
export function resetTutorial(): void { saved.del(KEYS.onboarded); saved.del(KEYS.tutorialDone); }

const kbd = (k: string): HTMLElement => h('kbd', {}, k);

// ---------- welcome cards ----------

const WELCOME: { art: string; title: string; body: (Node | string)[] }[] = [
  { art: '🍣', title: 'A sushi race with a knife in your back', body: ['Three minutes, up to four chefs, the same orders for everyone. Serve the most dishes and score the most points. Your rivals are AI chefs with their own NEAR wallets, or friends in a room.'] },
  { art: '🔪', title: 'Cook → plate → deliver', body: ['Grab ingredients from the crates, cook them in the rice cooker or pan, chop them on a board (', kbd('F'), '), put them on a plate and carry it to the hatch. Tickets in the top-left say what each order needs. Watch the pan: seared fish burns.'] },
  { art: '🌶️', title: 'Sabotage, quietly', body: ['Every dish you serve lights a Mischief pip. Spend pips on cards (', kbd('1'), '–', kbd('6'), '): a wasabi bomb in a rival’s pan, a dull knife, soy on their floor. They see what happened, never who did it.'] },
  { art: '🔍', title: 'Whodunit, and the chain keeps score', body: ['When the clock runs out, accuse whoever hit you: right is +40, wrong is −10. Every card was sealed on NEAR when it was played. Now the seals open and the contract checks them. Guests play free; a chef NFT is optional.'] },
];

/** The welcome cards. `play` starts the first shift (the walkthrough runs in it). */
export function welcome(play: () => void): void {
  let i = 0;
  const card = h('div', { class: 'welcome' });
  const finish = (go: boolean): void => { markOnboarded(); close(); if (go) play(); };
  const render = (): void => {
    const c = WELCOME[i];
    const last = i === WELCOME.length - 1;
    card.replaceChildren(
      h('div', { class: 'w-art', 'aria-hidden': 'true' }, c.art),
      h('h2', {}, c.title),
      h('p', {}, ...c.body),
      h('div', { class: 'dots', role: 'img', 'aria-label': `Card ${i + 1} of ${WELCOME.length}` }, ...WELCOME.map((_, k) => h('i', { class: k === i ? 'on' : '', onclick: () => { i = k; render(); } }))),
      h('div', { class: 'm-row' },
        h('button', { class: 'link', onclick: () => finish(false) }, last ? 'Look around first' : 'Skip'),
        h('span', { class: 'grow' }),
        i > 0 ? h('button', { class: 'ghost', onclick: () => { i--; render(); } }, 'Back') : null,
        h('button', { class: last ? 'big' : 'primary', 'data-autofocus': '', onclick: () => { if (last) finish(true); else { i++; render(); } } }, last ? (tutorialDone() ? 'Play a shift' : 'Play my first shift') : 'Next')),
    );
    card.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  };
  card.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && i < WELCOME.length - 1) { i++; render(); }
    if (e.key === 'ArrowLeft' && i > 0) { i--; render(); }
  });
  render();
  const close = openModal(card, { label: 'Welcome to Sushi Sabotage', onClose: markOnboarded });
}

// ---------- first-shift walkthrough ----------

type Flag = 'move' | 'grab' | 'plate' | 'heat' | 'chop' | 'build' | 'serve' | 'target' | 'card' | 'view';
type Skill = 'grab' | 'plate' | 'heat' | 'chop' | 'build' | 'serve';

/** The six things your first dish teaches, in whatever order the hint planner asks for them. */
const SKILLS: Record<Skill, { label: string; title: string; body: (Node | string)[] }> = {
  plate: { label: 'Plate', title: 'Grab a plate', body: ['Plates stack on the rack by the right wall (the yellow arrow). Walk up to it and press ', kbd('E'), ' (or ', kbd('Space'), ').'] },
  grab: { label: 'Ingredient', title: 'Grab an ingredient', body: ['Walk up to the crate the yellow arrow points at and press ', kbd('E'), ' to pick it up. You carry one thing at a time.'] },
  heat: { label: 'Cook', title: 'Cook it', body: ['Raw rice goes in the rice cooker; sliced fish or lobster in the pan. Press ', kbd('E'), ' at the station. It cooks by itself. Take it off before it burns.'] },
  chop: { label: 'Chop', title: 'Chop on a board', body: ['Put food on a cutting board (on the middle island) and tap ', kbd('F'), ' until it’s done. Cooked rice becomes sushi rice; fish, lobster and nori need chopping too.'] },
  build: { label: 'Plate up', title: 'Build the dish', body: ['Set the plate on the middle of the island, then bring each finished ingredient to it and press ', kbd('E'), '. The ticket top-left says what goes on.'] },
  serve: { label: 'Serve', title: 'Serve it', body: ['Carry the finished plate to the hatch at the front and press ', kbd('E'), '. A right dish scores, and a Mischief pip lights up.'] },
};
const SKILL_ORDER: Skill[] = ['plate', 'grab', 'heat', 'chop', 'build', 'serve'];

interface Stage { title: string; body: (Node | string)[]; flag?: Flag; tour?: string; kitchen?: boolean }

const STAGES: Stage[] = [
  { title: 'Walk around', flag: 'move', body: ['Move with ', kbd('W'), kbd('A'), kbd('S'), kbd('D'), ' or the arrow keys (the stick on a touch screen). The camera follows your stall.'] },
  { title: 'Cook your first dish', flag: 'serve', kitchen: true, tour: 'orders', body: [] },
  { title: 'Pick a target', flag: 'target', tour: 'board', body: ['Press ', kbd('Tab'), ' (or click a rival on the scoreboard) to choose who your cards hit. Their row turns red.'] },
  { title: 'Play a card', flag: 'card', tour: 'hand', body: ['Press a number, ', kbd('1'), '–', kbd('6'), '. Dull Knife (', kbd('3'), '), Soy Slick (', kbd('4'), ') and Order Shuffle (', kbd('5'), ') cost one pip. They’ll see the effect, never who did it.'] },
  { title: 'Spy on the street', flag: 'view', body: ['Press ', kbd('V'), ' to see all four kitchens, then ', kbd('V'), ' again to come back to yours.'] },
  { title: 'You’re cooking', tour: 'help', body: ['Keep the tickets moving until the clock runs out. Then comes Whodunit: guess who hit you. Press ', kbd('?'), ' any time for the full rules.'] },
];

/** Which skill the hint planner's next step is teaching. */
function skillOf(counter: number, action: 'act' | 'chop', heldPlate: boolean): Skill | null {
  const type = COUNTERS[counter]?.type;
  switch (type) {
    case 'plates': return 'plate';
    case 'container': return heldPlate ? 'build' : 'grab';
    case 'cooker': case 'pan': case 'pot': return 'heat';
    case 'board': return 'chop';
    case 'delivery': return 'serve';
    case 'trash': return null;
    default: return action === 'act' ? 'build' : null;
  }
}

/**
 * The coach panel. It watches the shift's events and state and moves on when you've actually done
 * the thing; it never blocks play. The "Cook your first dish" stage follows the hint planner, so it
 * teaches each skill at the moment your order needs it.
 */
export class Walkthrough implements ShiftWatcher {
  private i = 0;
  private flags = new Set<Flag>();
  private el = h('aside', { class: 'coach', 'aria-live': 'polite', 'aria-label': 'Walkthrough' });
  private advancing = 0;
  private views = 0;
  private glow: Element | null = null;
  private skill: Skill | null = null;
  private ended = false;

  constructor(private shift: Shift, root: HTMLElement, private onEnd: () => void = () => {}) {
    shift.watcher = this;
    shift.coaching = true;
    root.querySelector('.hud-root')?.append(this.el);
    this.show();
  }

  private btn(label: string, fn: () => void, cls = 'ghost'): HTMLElement {
    return h('button', { class: cls, onclick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); fn(); } }, label);
  }

  private show(): void {
    const st = STAGES[this.i];
    const last = this.i === STAGES.length - 1;
    const sk = st.kitchen && this.skill ? SKILLS[this.skill] : null;
    const live = st.kitchen && this.shift.hintText ? h('p', { class: 'c-live' }, `Next: ${this.shift.hintText}`) : '';
    this.el.classList.remove('done');
    this.el.classList.toggle('kitchen', !!st.kitchen);
    this.el.replaceChildren(
      h('div', { class: 'c-top' }, h('span', { class: 'c-step' }, `First shift · ${this.i + 1}/${STAGES.length}`), this.btn('Skip tutorial', () => this.end(), 'link')),
      h('div', { class: 'c-bar' }, h('i', { style: `width:${(this.i / (STAGES.length - 1)) * 100}%` })),
      h('h3', {}, sk ? sk.title : st.title),
      h('p', {}, ...(sk ? sk.body : st.kitchen ? ['Your order is on the ticket, top left. Follow the yellow arrow and the line below until the dish is served.'] : st.body)),
      live,
      st.kitchen ? h('ul', { class: 'c-check', 'aria-label': 'Your first dish' }, ...SKILL_ORDER.map((k) => h('li', { class: `${this.flags.has(k) ? 'ok' : ''}${k === this.skill ? ' now' : ''}` }, SKILLS[k].label))) : '',
      h('div', { class: 'c-row' },
        this.i > 0 ? this.btn('Back', () => { this.i--; this.show(); }) : '',
        h('span', { class: 'grow' }),
        st.flag ? h('span', { class: 'c-wait' }, 'waiting for you…') : '',
        st.flag ? this.btn('Skip step', () => this.next()) : this.btn(last ? 'Finish' : 'Next', () => this.next(), 'primary')),
    );
    this.glow?.classList.remove('tour-glow');
    this.glow = st.tour ? document.querySelector(`[data-tour="${st.tour}"]`) : null;
    this.glow?.classList.add('tour-glow');
    if (st.flag && this.flags.has(st.flag)) this.complete();
  }

  private next(): void {
    clearTimeout(this.advancing); this.advancing = 0;
    if (this.i >= STAGES.length - 1) { this.end(); return; }
    this.i++;
    this.skill = null;
    this.show();
  }

  /** Tick the stage off, then move on after a beat so the player sees it. */
  private complete(): void {
    if (this.advancing) return;
    this.el.classList.add('done');
    sfx.step();
    this.advancing = window.setTimeout(() => { this.advancing = 0; this.next(); }, 1000);
  }

  private set(flag: Flag): void {
    if (this.flags.has(flag)) return;
    this.flags.add(flag);
    const st = STAGES[this.i];
    if (st.flag === flag) { this.show(); this.complete(); return; }
    if (st.kitchen && flag === this.skill) { sfx.step(); this.show(); this.el.classList.add('tick'); setTimeout(() => this.el.classList.remove('tick'), 500); }
  }

  events(ev: SimEvent[]): void {
    const you = this.shift.you;
    for (const e of ev) {
      if (e.t === 'cast' && e.caster === you) this.set('card');
      if (!('chef' in e) || e.chef !== you) continue;
      const type = 'counter' in e ? COUNTERS[e.counter]?.type : undefined;
      if (e.t === 'pick' && type === 'container') this.set('grab');
      if (e.t === 'pick' && type === 'plates') this.set('plate');
      if (e.t === 'place' && type && isHeat(type)) this.set('heat');
      if (e.t === 'chop') this.set('chop');
      if (e.t === 'deliver') { this.set('build'); this.set('serve'); }
    }
  }

  frame(): void {
    const s = this.shift.state;
    if (!s || this.ended) return;
    const me = s.chefs[this.shift.you];
    if (Math.hypot(me.x - SPAWN.x, me.z - SPAWN.z) > 1.2) this.set('move');
    if ((me.held?.k === 'plate' && (me.held.on?.length ?? 0) >= 2) || me.st.some((x) => x.item?.k === 'plate' && (x.item.on?.length ?? 0) >= 2)) this.set('build');
    if (s.over) { this.end(); return; }
    // sit just under the order tickets, however many rows they take
    const rail = document.querySelector('[data-tour="orders"]')?.getBoundingClientRect();
    const top = `${Math.round(Math.max(rail?.bottom ?? 0, 60) + 14)}px`;
    if (this.el.style.top !== top) this.el.style.top = top;
    if (!STAGES[this.i].kitchen || this.advancing) return;
    // follow the planner: teach the skill the next step needs; once learnt, just show the next step
    const hint = this.shift.nextHint;
    const sk = hint ? skillOf(hint.counter, hint.action, me.held?.k === 'plate') : null;
    const want = sk && !this.flags.has(sk) ? sk : null;
    const live = this.el.querySelector('.c-live');
    if (want !== this.skill) { this.skill = want; this.show(); }
    else if (live && live.textContent !== `Next: ${this.shift.hintText}`) live.textContent = `Next: ${this.shift.hintText}`;
  }

  action(what: 'target' | 'view' | 'help'): void {
    if (what === 'target') this.set('target');
    if (what === 'view' && ++this.views >= 2 && !this.shift.isOverview) this.set('view');
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.advancing);
    this.glow?.classList.remove('tour-glow');
    this.el.remove();
    if (this.shift.watcher === this) this.shift.watcher = null;
    this.shift.coaching = false;
    markTutorialDone();
    this.onEnd();
  }
}

// ---------- How to play ----------

const CHAINS: [string, string[]][] = [
  ['Sushi rice', ['Raw rice', 'rice cooker 3 s', 'board, 3 chops']],
  ['Nori roll (maki)', ['Nori sheet', 'board, 3 chops']],
  ['Nori cone (temaki)', ['Nori cone', 'ready as it is']],
  ['Seared fish / lobster', ['Fish or lobster', 'board, 3 chops', 'pan 3 s', 'take it off within 5 s or it burns']],
  ['Blistered tomato', ['Tomato', 'board, 3 chops', 'pan 3 s']],
  ['Diced avocado', ['Avocado', 'board, 5 chops']],
  ['Wasabi slices / chutney', ['Wasabi', 'board, 3 chops = slices', 'pot 10 s = chutney']],
];

export function howToPlay(opts: { inShift: boolean; replay: () => void; onClose?: () => void }): void {
  const sec = (title: string, ...kids: (Node | string | null)[]): HTMLElement => h('section', {}, h('h3', {}, title), ...kids);
  const keys: [string[], string][] = [
    [['W', 'A', 'S', 'D'], 'move (or arrow keys)'], [['E'], 'pick up / put down / serve (or Space)'], [['F'], 'chop on a board, tap repeatedly'],
    [['1', '–', '6'], 'play a card'], [['Tab'], 'pick your target (or click the scoreboard)'], [['V'], 'see all four kitchens'],
    [['H'], 'hints on / off'], [['M'], 'sound on / off'], [['?'], 'this sheet'],
  ];
  const groups = [['maki', 'fish'], ['maki', 'lobster'], ['temaki', 'fish'], ['temaki', 'lobster']] as const;
  const card = h('div', { class: 'howto' },
    h('header', {}, h('h2', {}, 'How to play'), h('button', { class: 'x', 'aria-label': 'Close', onclick: () => close() }, '×')),
    h('div', { class: 'ht-cols' },
      sec('The shift',
        h('p', {}, 'Three minutes. Every chef gets the same orders in the same order, in their own stall. Serve the dish on a ticket before its bar runs out. Points, Mischief and the scoreboard are on the right; your tickets on the left.')),
      sec('Controls',
        h('dl', { class: 'keys' }, ...keys.flatMap(([k, v]) => [h('dt', {}, ...k.map((x) => (x === '–' ? '–' : kbd(x)))), h('dd', {}, v)])),
        h('p', { class: 'dim small' }, 'Touch screens: the stick moves, E picks up and puts down, Chop chops; tap a card or a rival.')),
      sec('Cooking chains',
        h('ul', { class: 'chains' }, ...CHAINS.map(([name, steps]) => h('li', {}, h('b', {}, name), h('span', {}, steps.join(' → '))))),
        h('p', {}, 'Then: grab a plate from the rack, set it on a counter, add every ingredient on the ticket, and carry it to the hatch at the front.')),
      sec('The 20 recipes',
        h('p', { class: 'dim small' }, 'Every dish is sushi rice + a base + seared fish or lobster, plus 0–4 extras in this order: tomato, avocado, wasabi slices, wasabi chutney.'),
        h('div', { class: 'recipes' }, ...groups.map(([style, protein]) => h('div', {},
          h('h4', {}, `${style === 'maki' ? 'Maki' : 'Temaki'} · ${protein}`),
          ...RECIPES.filter((r) => r.style === style && r.protein === protein).map((r) => h('div', { class: 'rec' }, h('b', {}, r.name),
            h('span', { class: 'chips' }, ...r.ingredients.slice(3).map((k) => h('span', { class: 'chip', style: `--c:${CHIP[k]}` }, CHIP_LABEL[k]))))))))),
      sec('Sabotage cards',
        h('p', {}, 'Every dish you serve lights one Mischief pip (up to 5). Cards spend pips, or a card you bought at the Night Market. 3 s cooldown between cards.'),
        h('ul', { class: 'cardlist' }, ...CARDS.map((c, k) => h('li', {}, kbd(String(k + 1)), h('b', {}, CARD_INFO[c].name), h('span', { class: 'cost' }, ...Array.from({ length: CARD_INFO[c].cost }, () => h('i'))), h('span', { class: 'dim' }, CARD_INFO[c].blurb))))),
      sec('Scoring',
        h('ul', {},
          h('li', {}, `A dish: ${SCORE.base} + ${SCORE.perIngredient} per ingredient, plus a tip of up to ${SCORE.maxTipFraction * 100} % for speed.`),
          h('li', {}, 'Streaks multiply: 3 in a row ×1.1, 5 ×1.25, 8 ×1.5.'),
          h('li', {}, `Burnt food ${SCORE.burn}, binned food ${SCORE.trash}, wrong dish ${SCORE.wrongDish}, an order gone cold ${SCORE.expired}.`))),
      sec('Whodunit and the proof',
        h('ul', {},
          h('li', {}, `After the shift, name a suspect for each card that hit you. Right: +${SCORE.accuseRight} to you and ${SCORE.caught} to them. Wrong: ${SCORE.accuseWrong}. Or pass.`),
          h('li', {}, 'Each card was sealed on NEAR testnet the moment it was played. The seals open at the end and the contract checks every one.'),
          h('li', {}, 'In a solo shift your browser runs the kitchen; the referee re-runs your input log and must reach the same state. Proof bundle (JSON) on the results screen has everything; pnpm verify <id> re-checks it.'))),
      sec('Wallets',
        h('p', {}, 'Guests play free, no wallet. Sign in with NEAR to mint a free chef NFT that keeps your purse, cards and record, buy cards from the Fixer and play ranked.')),
    ),
    h('div', { class: 'm-row' },
      h('button', { class: 'ghost', onclick: () => { resetTutorial(); close(); opts.replay(); } }, opts.inShift ? 'Replay tutorial next shift' : 'Replay tutorial'),
      h('span', { class: 'grow' }),
      h('button', { class: 'primary', 'data-autofocus': '', onclick: () => close() }, 'Got it')),
  );
  const close = openModal(card, { label: 'How to play', wide: true, onClose: opts.onClose });
}
