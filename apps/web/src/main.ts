import './style.css';
import { CARD_INFO, CARDS, stateHash, type Card, type LogEntry, type Result, type SimEvent, type State } from '@sushi/rules';
import { api, explorer, explorerAccount, type Me, type ServerConfig } from './api.ts';
import { isMuted, setMuted, sfx } from './audio.ts';
import { RoomShift, SoloShift, type Shift } from './game.ts';
import { chefCard, chefSlot, resultsCta, type ChefHooks } from './chef.ts';
import { Walkthrough, howToPlay, onboarded, tutorialDone, welcome } from './onboarding.ts';
import { CHEF_COLORS, KitchenScene } from './scene.ts';
import { $, h, modalOpen, mount, saved, toast } from './ui.ts';
import { call, setContract, signIn, signOut } from './wallet.ts';

const ui = $('#ui');
const hud = $('#hud');
const scene = new KitchenScene($<HTMLCanvasElement>('#c'));
let cfg: ServerConfig | null = null;
let me: Me | null = null;
let shift: Shift | null = null;
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const store = {
  get name(): string { try { return localStorage.getItem('sushi.name') ?? ''; } catch { return ''; } },
  set name(v: string) { try { localStorage.setItem('sushi.name', v); } catch { /* */ } },
  get difficulty(): Difficulty { try { const d = localStorage.getItem('sushi.difficulty'); return d === 'easy' || d === 'hard' ? d : 'normal'; } catch { return 'normal'; } },
  set difficulty(v: Difficulty) { try { localStorage.setItem('sushi.difficulty', v); } catch { /* */ } },
  /** Whether the player ever picked a level (first-timers get Easy preselected for the walkthrough). */
  get pickedDifficulty(): boolean { return saved.get('sushi.difficulty') !== null; },
};

// ---------- AI chef difficulty ----------

type Difficulty = 'easy' | 'normal' | 'hard';
const LEVELS: { id: Difficulty; label: string; hint: string }[] = [
  { id: 'easy', label: 'Easy', hint: 'Slow, clumsy AI chefs that burn things and rarely sabotage. Good for a first shift.' },
  { id: 'normal', label: 'Normal', hint: 'About as quick as you. They sabotage now and then.' },
  { id: 'hard', label: 'Hard', hint: 'Quick, tidy AI chefs that sabotage early and gang up on whoever leads.' },
];
const levelLabel = (d: string | undefined): string => LEVELS.find((l) => l.id === d)?.label ?? 'Normal';

/** Easy / Normal / Hard. Remembered in this browser. */
function difficultyPicker(current: Difficulty, pick: (d: Difficulty) => void, label = 'AI chefs'): HTMLElement {
  const hint = h('p', { class: 'dim small' }, LEVELS.find((l) => l.id === current)!.hint);
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'AI chef difficulty' }, ...LEVELS.map((l) => h('button', {
    class: l.id === current ? 'on' : '', role: 'radio', 'aria-checked': String(l.id === current), title: l.hint,
    onclick: (e: Event) => {
      store.difficulty = l.id;
      [...seg.children].forEach((b) => { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-checked', String(b === e.currentTarget)); });
      hint.textContent = l.hint;
      pick(l.id);
    },
  }, l.label)));
  return h('div', { class: 'difficulty' }, h('small', { class: 'field-label' }, label), seg, hint);
}

// ---------- boot ----------

async function boot(): Promise<void> {
  mount(ui, h('div', { class: 'panel center loading' }, logo(), h('p', { class: 'dim' }, 'Lighting the lanterns…'), h('div', { class: 'spinner', 'aria-hidden': 'true' })));
  await scene.load();
  scene.build(['', '', '', ''], 0);
  scene.overview = true;
  idleLoop();
  cfg = await api<ServerConfig>('/config').catch(() => null);
  if (cfg) setContract(cfg.contract);
  me = await api<Me | null>('/me').catch(() => null); // null for a guest; signed in if the session cookie is still good
  title();
  if (!onboarded()) welcome(() => solo(3, 'easy'));
}

function idleLoop(): void {
  let last = performance.now();
  const f = (t: number): void => { if (!shift) scene.render(Math.min(0.1, (t - last) / 1000)); last = t; requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

const chefName = (): string => (me?.raw?.kind.Chef?.name ?? store.name) || 'Chef';

function logo(small = false): HTMLElement {
  return h(small ? 'span' : 'h1', { class: small ? 'logo small' : 'logo' }, h('span', { class: 'roll', 'aria-hidden': 'true' }), 'Sushi', h('em', {}, 'Sabotage'));
}

let page = 'title';

/** What the chef module (chef.ts) needs from the page. */
const chefHooks: ChefHooks = {
  me: () => me,
  refresh: async () => {
    me = await api<Me | null>('/me').catch(() => me);
    if (page === 'chef') void myChef();
    else if (page === 'title') title();
    else fillSlot('results-cta', lastCta());
  },
  signIn: () => doSignIn(),
  defaultName: () => chefName(),
};
let lastCta: () => HTMLElement | null = () => null;
/** Puts the chef module's content into one of the page's slots (if it's on screen). */
function fillSlot(id: string, el: HTMLElement | null): void {
  const slot = document.getElementById(id);
  if (slot) slot.replaceChildren(...(el ? [el] : []));
}
function nav(): HTMLElement {
  const item = (id: string, label: string, fn: () => void): HTMLElement => h('button', { class: page === id ? 'on' : '', 'aria-current': page === id ? 'page' : undefined, onclick: fn }, label);
  // On a phone the links fold into a Menu; the sound toggle stays in the bar.
  const links = h('div', { class: 'nav-links', id: 'nav-links' },
    item('title', 'Kitchen', title),
    item('market', 'Night Market', market),
    item('chef', 'My Chef', myChef),
    item('board', 'Leaderboard', board),
    item('agents', 'Agents', agents),
    h('button', { onclick: () => { setOpen(false); howTo(); } }, 'How to play'));
  const toggle = h('button', { class: 'nav-menu', 'aria-expanded': 'false', 'aria-controls': 'nav-links', onclick: () => setOpen(!el.classList.contains('open')) }, h('span', { 'aria-hidden': 'true' }, '☰'), ' Menu');
  const outside = (e: Event): void => { if (!el.contains(e.target as Node)) setOpen(false); };
  const setOpen = (open: boolean): void => {
    el.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('pointerdown', outside); else document.removeEventListener('pointerdown', outside);
  };
  const el = h('nav', { class: 'nav' },
    h('button', { class: 'brand', onclick: title, 'aria-label': 'Sushi Sabotage: back to the kitchen' }, logo(true)),
    links,
    h('button', { class: 'mute', 'aria-label': 'Sound on/off', onclick: (e: Event) => { setMuted(!isMuted()); (e.currentTarget as HTMLElement).textContent = isMuted() ? '🔇' : '🔊'; } }, isMuted() ? '🔇' : '🔊'),
    toggle);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.classList.contains('open')) { setOpen(false); toggle.focus(); } });
  return el;
}

function walletBadge(): HTMLElement {
  if (me) return h('div', { class: 'wallet' }, h('a', { href: explorerAccount(me.accountId), target: '_blank' }, me.accountId), h('button', { class: 'link', onclick: async () => { await signOut(); me = null; title(); } }, 'sign out'));
  return h('div', { class: 'wallet' }, h('button', { class: 'ghost', onclick: doSignIn }, 'Sign in with NEAR'), h('small', {}, 'optional: guests play free'));
}

async function doSignIn(): Promise<void> {
  try {
    await signIn();
    me = await api<Me | null>('/me');
    if (!me) throw new Error('signed in, but the session cookie did not stick: allow cookies for this site and try again');
    toast(`Signed in as ${me.accountId}`, 'good');
    if (!me.chef) myChef(); else title();
  } catch (e) { toast((e as Error).message, 'bad'); }
}

// ---------- title ----------

function title(): void {
  stopShift();
  page = 'title';
  scene.overview = true;
  const name = h('input', { id: 'chef-name', value: chefName(), maxlength: 20, placeholder: 'Your chef name', autocomplete: 'nickname', oninput: (e: Event) => { store.name = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9 _-]/g, ''); } });
  const first = !tutorialDone();
  let rivals = 3;
  let level: Difficulty = first && !store.pickedDifficulty ? 'easy' : store.difficulty;
  const rivalBtns = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Rivals' }, ...[1, 2, 3].map((n) => h('button', { class: n === rivals ? 'on' : '', role: 'radio', 'aria-checked': String(n === rivals), onclick: (e: Event) => { rivals = n; [...(e.currentTarget as HTMLElement).parentElement!.children].forEach((b, k) => { b.classList.toggle('on', k + 1 === n); b.setAttribute('aria-checked', String(k + 1 === n)); }); } }, `${n} rival${n > 1 ? 's' : ''}`)));
  const code = h('input', { placeholder: 'ROOM', maxlength: 4, class: 'code', 'aria-label': 'Room code', oninput: (e: Event) => { (e.target as HTMLInputElement).value = (e.target as HTMLInputElement).value.toUpperCase(); }, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') room({ t: 'join', code: code.value }); } });
  mount(ui, nav(), h('div', { class: 'panel title' },
    h('header', { class: 'hero' },
      logo(),
      h('p', { class: 'tag' }, 'Roll it, sear it, serve it. Wreck your rivals’ dishes while they cook. Nobody sees who did it until the shift ends.')),
    h('div', { class: 'who' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Chef name'), name),
      walletBadge()),
    // the lead's chef card / "Mint your chef — free" call to action renders here
    h('div', { id: 'chef-slot', class: 'slot' }),
    h('div', { class: 'modes' },
      h('section', { class: 'mode solo' },
        h('div', { class: 'mode-head' }, h('span', { class: 'mode-icon', 'aria-hidden': 'true' }, '🍣'), h('div', {}, h('h3', {}, 'Solo shift'), h('p', { class: 'dim' }, 'You vs AI chefs with their own NEAR wallets.'))),
        h('div', {}, h('small', { class: 'field-label' }, 'Rivals'), rivalBtns),
        difficultyPicker(level, (d) => { level = d; }),
        first ? h('p', { class: 'firsttip' }, '✨ First shift? A coach walks you through it, step by step. Easy chefs are a good start.') : null,
        h('button', { class: 'big', onclick: () => solo(rivals, level) }, first ? 'Start my first shift' : 'Start shift')),
      h('section', { class: 'mode multi' },
        h('div', { class: 'mode-head' }, h('span', { class: 'mode-icon', 'aria-hidden': 'true' }, '🏮'), h('div', {}, h('h3', {}, 'Multiplayer'), h('p', { class: 'dim' }, '2–4 chefs in one street. Fill empty stalls with AI.'))),
        h('button', { class: 'big alt', onclick: () => room({ t: 'create' }) }, 'Create room'),
        h('div', {}, h('small', { class: 'field-label' }, 'Have a code?'), h('div', { class: 'join' }, code, h('button', { onclick: () => room({ t: 'join', code: code.value }) }, 'Join'))))),
    h('div', { class: 'title-links' },
      h('button', { class: 'link', onclick: howTo }, 'How to play'),
      h('button', { class: 'link', onclick: () => welcome(() => solo(3, 'easy')) }, 'The intro again')),
    h('p', { class: 'foot' }, 'NEAR testnet · contract ', h('a', { href: explorerAccount(cfg?.contract ?? ''), target: '_blank' }, cfg?.contract ?? '…'), ' · part of the NEAR Arcade')));
  fillSlot('chef-slot', chefSlot(chefHooks, () => void myChef()));
}

function stopShift(): void { shift?.stop(); shift = null; hud.replaceChildren(); }

function countdown(then: () => void, line?: { who: string; text: string; signed: boolean } | null): void {
  let n = 3;
  const box = h('div', { class: 'count' }, '3');
  mount(ui, h('div', { class: 'panel center countdown' }, line ? h('blockquote', { class: 'taunt' }, `“${line.text}”`, h('cite', {}, `— ${line.who}${line.signed ? ' · signed by a TEE model on NEAR AI' : ''}`)) : null, box));
  sfx.tick();
  const t = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(t); sfx.go(); mount(ui); then(); return; }
    box.textContent = String(n); box.classList.remove('beat'); void box.offsetWidth; box.classList.add('beat'); sfx.tick();
  }, 1000);
}

// ---------- solo ----------

async function solo(rivals: number, difficulty: Difficulty): Promise<void> {
  try {
    const r = await api<{ matchId: string; setup: { seed: string; chefs: { name: string }[] }; ranked: boolean; fee: number; seedHash: string; line: { who: string; text: string; signed: boolean } | null; noEnergy?: boolean; recorded?: boolean }>('/solo/start', { name: chefName(), bots: rivals, loadout: loadoutChoice(), difficulty });
    if (r.noEnergy) toast('Your chef is out of energy: this shift plays as a guest and isn’t recorded', 'bad');
    soloRecord = { recorded: !!r.recorded, noEnergy: !!r.noEnergy };
    scene.overview = false;
    lastSolo = { rivals, difficulty };
    const coach = !tutorialDone();
    countdown(() => {
      const s = new SoloShift(scene, r.setup as never, hud, async ({ state, log }) => {
        setTimeout(() => void soloEnd(r.matchId, state, log, r.ranked), 900);
      });
      s.canPause = !r.ranked;
      s.openHelp = () => shiftHelp(s);
      shift = s;
      if (coach) new Walkthrough(s, hud); // remembers itself as done when it ends
    }, r.line);
  } catch (e) { toast((e as Error).message, 'bad'); }
}

let lastSolo: { rivals: number; difficulty: Difficulty } | null = null;
/** whether the running solo shift goes on the chef NFT (a guest's or an out-of-energy shift doesn't) */
let soloRecord = { recorded: false, noEnergy: false };

/** How to play during a shift: a solo, unranked shift pauses while it's open. */
function shiftHelp(s: Shift): void {
  if (modalOpen()) return;
  if (s.canPause) s.paused = true;
  howToPlay({
    inShift: true,
    replay: () => { if (s.watcher instanceof Walkthrough) s.watcher.end(false); toast('The walkthrough runs in your next solo shift', 'good'); },
    onClose: () => { s.paused = false; },
  });
}

async function soloEnd(matchId: string, state: State, log: LogEntry[], ranked: boolean): Promise<void> {
  stopShift();
  scene.overview = true;
  const names = state.chefs.map((c) => c.name);
  const hits = state.sab.map((x, k) => ({ x, k })).filter(({ x }) => x.target === 0 && x.card !== 'bamboo_shield').map(({ x, k }) => ({ sab: k, card: x.card, tick: x.tick, blocked: x.blocked }));
  const accusations = await new Promise<{ sab: number; accused: number }[]>((resolve) => {
    if (!hits.length) { resolve([]); return; }
    whodunitPanel({ hits, until: Date.now() + 30_000, names }, 0, resolve,
      ranked ? 'Ranked solo: your browser ran the sim, so your guesses are for fun and don’t score. The AI chefs’ guesses do.' : 'Who hit you? Right: +40 to you, −40 to them. Wrong: −10.');
  });
  mount(ui, h('div', { class: 'panel center' }, h('h2', { class: 'display' }, 'Shift over!'), h('p', {}, 'The referee is re-running your shift to check it…'), h('div', { class: 'spinner', 'aria-hidden': 'true' })));
  try {
    const r = await api<ResultsMsg>('/solo/finish', { matchId, log, stateHash: stateHash(state), accusations });
    results({ ...r, txs: [], names, you: 0, solo: true, ...soloRecord });
    pollTxs(matchId);
  } catch (e) { toast((e as Error).message, 'bad'); title(); }
}

function loadoutChoice(): number[] {
  // bring up to one of each card you own
  const inv = me?.raw?.kind.Chef?.inventory ?? [];
  return CARDS.map((_, k) => Math.min(1, inv[k] ?? 0));
}

// ---------- multiplayer ----------

let ws: WebSocket | null = null;

function room(first: { t: 'create' } | { t: 'join'; code: string }): void {
  ws?.close();
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  let names: string[] = [];
  let you = 0;
  sock.onopen = () => {
    sock.send(JSON.stringify({ t: 'hello', name: chefName() }));
    sock.send(JSON.stringify(first));
    if (first.t === 'create') sock.send(JSON.stringify({ t: 'difficulty', level: store.difficulty })); // the host's last pick
  };
  sock.onclose = () => { if (ws === sock && shift instanceof RoomShift && !shift.ended) { toast('Disconnected from the kitchen', 'bad'); title(); } };
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Record<string, unknown> & { t: string };
    switch (m.t) {
      case 'error': toast(String(m.msg), 'bad'); break;
      case 'kicked': toast('The host removed you', 'bad'); title(); break;
      case 'room': lobby(sock, m as unknown as LobbyMsg); break;
      case 'start': names = m.names as string[]; you = m.you as number; scene.overview = false; countdown(() => { const s = new RoomShift(scene, you, names, hud, sock); s.openHelp = () => shiftHelp(s); shift = s; }); break;
      case 'line': toast(`${m.who}: “${m.text}”`); break;
      case 'snap': if (shift instanceof RoomShift) shift.snapshot(m.s as State, m.ev as SimEvent[]); break;
      case 'whodunit': if (shift) shift.ended = true; stopShift(); scene.overview = true; whodunit(sock, m as unknown as WhoMsg, you); break;
      case 'results': results({ ...(m as unknown as ResultsMsg), names, you }); break;
    }
  };
}

interface LobbyMsg { code: string; phase: string; difficulty?: Difficulty; seats: { name: string; kind: string; ready: boolean; signedIn: boolean; here: boolean }[]; you: number; host: boolean }
function lobby(sock: WebSocket, m: LobbyMsg): void {
  if (m.phase !== 'lobby') return;
  const mine = m.seats[m.you];
  page = 'lobby';
  mount(ui, nav(), h('div', { class: 'panel lobby' },
    h('h2', {}, 'Room ', h('button', { class: 'roomcode', title: 'Copy the code', onclick: () => { void navigator.clipboard?.writeText(m.code).then(() => toast('Room code copied', 'good'), () => {}); } }, m.code)),
    h('p', { class: 'dim' }, 'Share the code. Everyone presses Ready to start. Empty pods stay empty unless the host adds an AI chef.'),
    h('ul', { class: 'seats' }, ...m.seats.map((s, i) => h('li', { class: s.ready ? 'ready' : '', style: `--c:${hex(CHEF_COLORS[i % 4])}` }, h('span', { class: 'dot' }), h('b', {}, s.name, i === m.you ? ' (you)' : ''), h('small', {}, s.kind === 'bot' ? 'AI chef · own NEAR wallet' : s.signedIn ? 'NEAR wallet' : 'guest'), s.ready ? h('em', {}, 'ready') : h('em', { class: 'dim' }, 'not ready'),
      m.host && i !== m.you ? h('button', { class: 'link', onclick: () => sock.send(JSON.stringify({ t: 'kick', seat: i })) }, 'remove') : null))),
    h('div', { class: 'row' },
      m.host && m.seats.length < 4 ? h('button', { onclick: () => sock.send(JSON.stringify({ t: 'addBot' })) }, 'Add AI chef') : null,
      m.host
        ? difficultyPicker(m.difficulty ?? 'normal', (level) => sock.send(JSON.stringify({ t: 'difficulty', level })))
        : h('p', { class: 'dim' }, `AI chefs: ${levelLabel(m.difficulty)} (the host picks)`),
      h('button', { class: mine.ready ? 'big alt' : 'big', onclick: () => sock.send(JSON.stringify({ t: 'ready', ready: !mine.ready, loadout: loadoutChoice() })) }, mine.ready ? 'Not ready' : 'Ready'),
      h('button', { class: 'ghost', onclick: () => { sock.send(JSON.stringify({ t: 'leave' })); sock.close(); title(); } }, 'Leave'))));
}

interface WhoMsg { hits: { sab: number; card: Card; tick: number; blocked: boolean }[]; until: number; names: string[] }
function whodunit(sock: WebSocket, m: WhoMsg, you: number): void {
  if (!m.hits.length) { mount(ui, h('div', { class: 'panel center' }, h('h2', { class: 'display' }, 'Whodunit'), h('p', {}, 'Nobody sabotaged you this shift. Waiting for the others to accuse…'))); return; }
  whodunitPanel(m, you, (list) => { sock.send(JSON.stringify({ t: 'accuse', list })); mount(ui, h('div', { class: 'panel center' }, h('h2', {}, 'Accusations sealed'), h('p', {}, 'Waiting for the reveal…'))); });
}

/** The accusation screen, shared by multiplayer (sent over the socket) and solo (sent with the log). */
function whodunitPanel(m: WhoMsg, you: number, submit: (list: { sab: number; accused: number }[]) => void, note?: string): void {
  const picks = new Map<number, number>();
  let sent = false;
  const send = (): void => { if (sent) return; sent = true; clearInterval(iv); submit([...picks].map(([sab, accused]) => ({ sab, accused }))); };
  const timer = h('span', { class: 'timer' });
  // when time runs out, whatever you picked is sealed (unpicked hits count as a pass)
  const iv = setInterval(() => { const s = Math.max(0, Math.ceil((m.until - Date.now()) / 1000)); timer.textContent = `${s}s`; if (s <= 0) send(); }, 250);
  mount(ui, h('div', { class: 'panel whodunit' },
    h('h2', { class: 'display' }, 'Whodunit? ', timer),
    h('p', { class: 'dim' }, note ?? 'For each sabotage that hit you, name the culprit. Right: +40 to you, −40 to them. Wrong: −10. The seals open onchain next.'),
    h('div', { class: 'hits' }, ...m.hits.map((x) => h('div', { class: 'hit' },
      h('div', { class: 'hit-what' }, h('b', {}, CARD_INFO[x.card].name), h('small', { class: 'dim' }, ` at ${fmtClock(x.tick)}${x.blocked ? ' (blocked)' : ''} · ${CARD_INFO[x.card].blurb}`)),
      h('div', { class: 'seg' }, ...m.names.map((n, i) => (i === you ? null : h('button', { onclick: (e: Event) => { picks.set(x.sab, i); [...(e.target as HTMLElement).parentElement!.children].forEach((b) => b.classList.remove('on')); (e.target as HTMLElement).classList.add('on'); } }, n))), h('button', { class: 'on', onclick: (e: Event) => { picks.delete(x.sab); [...(e.target as HTMLElement).parentElement!.children].forEach((b) => b.classList.remove('on')); (e.target as HTMLElement).classList.add('on'); } }, 'pass'))))),
    h('button', { class: 'big', onclick: send }, 'Seal my accusations')));
}

interface ResultsMsg { difficulty?: string; verified?: boolean; stateHash?: string; results: Result[]; reveal: { caster: number; target: number; card: Card; tick: number; blocked: boolean; fizzled: boolean }[]; accusations: { victim: number; sab: number; accused: number }[]; matchId: string; txs: { what: string; hash: string; url?: string }[]; ranked: boolean; error?: string }
const fmtClock = (tick: number): string => { const t = Math.floor(tick / 20); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

function results(r: ResultsMsg & { names: string[]; you: number; solo?: boolean; recorded?: boolean; noEnergy?: boolean }): void {
  stopShift();
  page = 'results';
  scene.overview = true;
  const sorted = [...r.results].sort((a, b) => a.rank - b.rank);
  const accused = new Map(r.accusations.map((a) => [a.sab, a]));
  const mine = sorted.find((x) => x.chef === r.you);
  const won = sorted[0]?.chef === r.you;
  if (won) sfx.fanfare(); else sfx.deliver();
  const color = (i: number): string => hex(CHEF_COLORS[i % 4]);
  const place = ['1st', '2nd', '3rd', '4th'];
  // podium: 2nd, 1st, 3rd (and 4th to the side)
  const podium = [sorted[1], sorted[0], sorted[2]].filter((x): x is Result => !!x);
  const delta = (d: number): string => (d ? (d > 0 ? `+${d}` : String(d)) : '—');
  mount(ui, nav(), h('div', { class: 'panel results' },
    h('header', { class: 'res-head' },
      h('h2', { class: 'display' }, won ? 'You ran the best kitchen tonight!' : mine ? `You finished ${place[mine.rank - 1] ?? `#${mine.rank}`}` : 'Shift results'),
      r.difficulty ? h('span', { class: 'pill' }, `AI chefs: ${levelLabel(r.difficulty)}`) : null,
      r.ranked ? h('span', { class: 'pill hot' }, 'Ranked') : null),
    h('div', { class: 'podium' }, ...podium.map((x) => h('div', { class: `step p${x.rank}${x.chef === r.you ? ' you' : ''}`, style: `--c:${color(x.chef)}` },
      h('div', { class: 'who' }, x.rank === 1 ? h('span', { class: 'crown', 'aria-hidden': 'true' }, '👑') : null, h('b', {}, x.name), x.chef === r.you ? h('small', {}, 'you') : null),
      h('div', { class: 'block' }, h('span', { class: 'place' }, place[x.rank - 1]), h('span', { class: 'pts' }, String(x.final)))))),
    h('table', { class: 'scores' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Chef'), h('th', {}, 'Shift'), h('th', {}, 'Whodunit'), h('th', {}, 'Final'))),
      h('tbody', {}, ...sorted.map((x) => h('tr', { class: x.chef === r.you ? 'you' : '' }, h('td', {}, String(x.rank)), h('td', {}, h('span', { class: 'dot', style: `--c:${color(x.chef)}` }), ' ', x.name), h('td', {}, String(x.shiftScore)), h('td', { class: x.accuseDelta > 0 ? 'good' : x.accuseDelta < 0 ? 'bad' : 'dim' }, delta(x.accuseDelta)), h('td', {}, h('b', {}, String(x.final))))))),
    r.solo ? h('p', { class: `verdict ${r.verified ? 'good' : 'bad'}` }, r.verified ? `✓ The referee re-ran your shift from the input log and reached the same state (${r.stateHash?.slice(0, 12)}…).` : '✗ The referee’s replay did not match your browser; the referee’s result stands.') : null,
    // the lead's post-shift call to action (sign in / mint your chef) renders here
    h('div', { id: 'results-cta', class: 'slot' }),
    h('h3', {}, 'The sealed sabotage log, opened'),
    r.reveal.length ? h('ol', { class: 'reveal' }, ...r.reveal.map((x, k) => {
      const a = accused.get(k);
      return h('li', { style: `--c:${color(x.caster)}` }, h('span', { class: 'when' }, fmtClock(x.tick)),
        h('span', {}, h('b', { style: `color:${color(x.caster)}` }, r.names[x.caster] ?? `#${x.caster}`), ` played `, h('b', {}, CARD_INFO[x.card].name), CARD_INFO[x.card].self ? '' : h('span', {}, ' on ', h('b', { style: `color:${color(x.target)}` }, r.names[x.target] ?? `#${x.target}`)),
          x.blocked ? h('span', { class: 'tag-s' }, 'blocked') : x.fizzled ? h('span', { class: 'tag-s' }, 'fizzled') : null),
        a ? h('span', { class: `acc ${a.accused === x.caster ? 'good' : 'bad'}` }, `${r.names[a.victim]} accused ${r.names[a.accused]} ${a.accused === x.caster ? '✓' : '✗'}`) : null);
    })) : h('p', { class: 'dim' }, 'Nobody played a card.'),
    r.solo ? h('p', { class: 'dim small' }, r.ranked ? 'Ranked solo: your browser ran the sim, so only the AI chefs’ accusations score. In multiplayer the server never tells anyone who cast what.' : 'Solo, unranked: your accusations scored. In multiplayer the server never tells anyone who cast what.') : null,
    h('h3', {}, 'Onchain proof'),
    h('div', { class: 'proof', id: 'proof' }, proofLinks({ ...r, recorded: (lastShiftRecorded = r.recorded ?? !!me?.chef) })),
    h('div', { class: 'row actions' },
      r.solo && lastSolo ? h('button', { class: 'big', onclick: () => solo(lastSolo!.rivals, lastSolo!.difficulty) }, 'Play again') : null,
      h('button', { class: r.solo && lastSolo ? 'ghost' : 'big', onclick: title }, 'Back to the kitchen'),
      h('a', { class: 'btn ghost', href: `/api/match/${r.matchId}`, target: '_blank' }, 'Proof bundle (JSON)'))));
  // a guest is invited to sign in and mint; a chef sees its energy (refreshed after the shift)
  const recorded = r.recorded ?? !!me?.chef;
  lastCta = () => resultsCta(chefHooks, recorded, !!r.noEnergy);
  fillSlot('results-cta', lastCta());
  if (me) void api<Me | null>('/me').then((m) => { me = m; if (page === 'results') fillSlot('results-cta', lastCta()); }).catch(() => undefined);
}

let lastShiftRecorded = false;

/** A match's chain error in a sentence (the server keeps the raw one in the proof bundle). */
function chainError(e: string): string {
  const what = /^(\w+)/.exec(e)?.[1] ?? 'a chain call';
  if (/LackBalanceForState/.test(e)) return `Not recorded onchain: ${what} failed because the contract is out of storage NEAR.`;
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(e)?.[1];
  if (panic) return `Not recorded onchain: ${what} was refused (${panic}).`;
  return `Not recorded onchain: ${what} failed. The full error is in the proof bundle.`;
}

function proofLinks(r: { txs: { what: string; hash: string; url?: string }[]; ranked: boolean; error?: string; matchId: string; recorded?: boolean }): HTMLElement {
  const unranked = r.recorded
    ? 'Unranked (no entry fee). The shift still lands on your chef NFT: XP, stats and energy.'
    : 'Unranked (no entry fee). The match is sealed and settled onchain; the AI chefs’ stats land on their NFTs, and as a guest nothing lands on a chef of yours.';
  return h('div', {},
    h('p', { class: 'dim' }, r.ranked ? 'Ranked: entry fees went into the pot; prizes and recipe-scroll royalties are paid by the contract.' : unranked),
    r.txs.length ? h('ul', { class: 'txs' }, ...r.txs.map((t) => h('li', {}, h('a', { href: t.url ?? explorer(t.hash), target: '_blank' }, t.what), ' ', h('code', {}, `${t.hash.slice(0, 10)}…`)))) : r.error ? null : h('p', { class: 'dim' }, 'Settling onchain…'),
    r.error ? h('p', { class: 'bad' }, chainError(r.error)) : null);
}

function pollTxs(matchId: string, tries = 0): void {
  setTimeout(async () => {
    const m = await api<{ txs: { what: string; hash: string; url: string }[]; settled: boolean; ranked: boolean; error?: string }>(`/match/${matchId}`).catch(() => null);
    const box = document.getElementById('proof');
    if (!m || !box) return;
    box.replaceChildren(proofLinks({ ...m, matchId, recorded: lastShiftRecorded }));
    if (!m.settled && !m.error && tries < 20) pollTxs(matchId, tries + 1);
  }, 3000);
}

// ---------- the Night Market (the Fixer) ----------

async function market(): Promise<void> {
  stopShift();
  page = 'market';
  const m = await api<{ prices: Record<Card, number> }>('/market').catch(() => null);
  if (!m) { toast('market closed', 'bad'); return; }
  let card: Card = 'wasabi_bomb';
  let round: 0 | 1 = 0;
  const chat = h('div', { class: 'chat' }, h('p', { class: 'npc' }, h('b', {}, 'The Fixer: '), 'Psst. Cards for the discerning chef. Prices move with demand. Make me an offer.'));
  const offer = h('input', { type: 'number', min: 1, value: String(m.prices[card]) });
  const said = h('input', { placeholder: 'Say something (optional)…', maxlength: 200 });
  const cards = h('div', { class: 'shop' }, ...CARDS.map((c) => h('button', { class: c === card ? 'on' : '', onclick: (e: Event) => { card = c; round = 0; offer.value = String(m.prices[c]); [...cards.children].forEach((b) => b.classList.remove('on')); (e.currentTarget as HTMLElement).classList.add('on'); } },
    h('b', {}, CARD_INFO[c].name), h('small', {}, CARD_INFO[c].blurb), h('span', { class: 'price' }, `${m.prices[c]} ryo`))));
  const say = (who: string, text: string, cls = 'npc'): void => { chat.append(h('p', { class: cls }, h('b', {}, `${who}: `), text)); chat.scrollTop = chat.scrollHeight; };
  const haggle = async (): Promise<void> => {
    if (!me) { toast('Sign in with a NEAR wallet to buy cards', 'bad'); return; }
    if (!me.chef) { myChef(); return; }
    say('You', `${said.value || 'How about this?'} (${offer.value} ryo for ${CARD_INFO[card].name})`, 'me');
    try {
      const r = await api<{ outcome: { kind: string; price: number }; line: { who: string; text: string; signed: boolean }; offer: { offerId: number; url: string } | null }>('/market/haggle', { card, offer: Number(offer.value), round, said: said.value });
      say(r.line.who, `${r.line.text}${r.line.signed ? ' 🔏' : ''}`);
      if (r.outcome.kind === 'counter') { round = 1; offer.value = String(r.outcome.price); }
      else if (r.outcome.kind === 'refuse') round = 0;
      else if (r.offer) {
        say('Receipt', `Offer posted onchain`, 'sys');
        say('Wallet', 'Approve the purchase in your wallet (no gas: the game relays it).', 'sys');
        const res = await call('accept_offer', { offer_id: r.offer.offerId });
        say('Receipt', `You bought ${CARD_INFO[card].name} for ${r.outcome.price} ryo${res.gasless ? ', gas paid by the game' : ''}. Tx ${res.tx.slice(0, 10)}…`, 'sys');
        me = await api<Me | null>('/me');
        round = 0;
      }
    } catch (e) { say('Error', (e as Error).message, 'sys'); }
  };
  mount(ui, nav(), h('div', { class: 'panel market' },
    h('h2', {}, 'Night Market'),
    h('p', { class: 'dim' }, 'The Fixer is an AI agent with its own NEAR account. The rules set every price (demand raises it, it decays over an hour); the TEE-hosted model only does the talking. 🔏 = reply signed by the enclave.'),
    cards, chat, h('div', { class: 'row' }, offer, said, h('button', { class: 'big', onclick: haggle }, 'Offer')),
    me?.raw ? h('p', { class: 'dim' }, `Purse: ${me.raw.purse} ryo · cards: ${CARDS.map((c, k) => `${CARD_INFO[c].name} ${me!.raw!.kind.Chef?.inventory[k] ?? 0}`).join(', ')}`) : walletBadge()));
}

// ---------- my chef (the NFT) ----------

async function myChef(): Promise<void> {
  stopShift();
  page = 'chef';
  const [card, owned] = await Promise.all([chefCard(chefHooks), fetchOwned().catch(() => [])]);
  if (page !== 'chef') return;
  const others = owned.filter((o) => o.token_id !== me?.chef);
  mount(ui, nav(), card, ...(others.length ? [h('div', { class: 'panel' },
    h('h3', {}, 'Your other tokens'),
    h('div', { class: 'owned' }, ...others.map((o) => h('div', { class: 'tok' }, h('img', { src: o.metadata.media }), h('small', {}, o.metadata.title)))),
    h('p', { class: 'dim' }, 'Recipe Scrolls earn 2 ryo from the pot every time anyone serves their recipe in a ranked match. Move a scroll’s earnings into your chef with move_purse.'))] : []));
}

async function fetchOwned(): Promise<{ token_id: string; metadata: { title: string; media: string; description: string } }[]> {
  // through the server, which falls back across several RPCs (public ones rate-limit browsers)
  return me ? api('/owned') : [];
}

// ---------- leaderboard, agents, how to play ----------

async function board(): Promise<void> {
  stopShift();
  page = 'board';
  const [rows, matches] = await Promise.all([
    api<{ chef: string; name: string; best: number }[]>('/leaderboard').catch(() => []),
    api<{ id: string; mode: string; createdAt: number; names: string[]; results?: Result[]; settled: boolean; ranked: boolean }[]>('/matches').catch(() => []),
  ]);
  mount(ui, nav(), h('div', { class: 'panel' },
    h('h2', {}, 'Season leaderboard'), h('p', { class: 'dim' }, 'Best ranked score per chef NFT, kept by the contract.'),
    rows.length ? h('ol', { class: 'lb' }, ...rows.map((r) => h('li', {}, h('b', {}, r.name), h('small', {}, ` ${r.chef}`), h('span', {}, String(r.best))))) : h('p', { class: 'dim' }, 'No ranked shifts yet. Sign in, enable ranked on your chef and play one.'),
    h('h3', {}, 'Recent shifts'),
    h('ul', { class: 'matches' }, ...matches.map((m) => h('li', {}, h('a', { href: `/api/match/${m.id}`, target: '_blank' }, m.id), ` · ${m.mode} · ${m.names.join(', ')}`, m.results ? ` · winner ${[...m.results].sort((a, b) => a.rank - b.rank)[0]?.name}` : '', m.settled ? ' · settled ✓' : '')))));
}

async function agents(): Promise<void> {
  stopShift();
  page = 'agents';
  type Budget = { left: number; forPlayers: number; forLeague: number; leagueEntries: number };
  const a = await api<{ storage?: string | null; acts: { at: number; who: string; what: string; url?: string; failed?: boolean }[]; chefs: { name: string; account: string; skill: string; budget?: Budget }[]; league?: { rankedRoundsLeft: number; playerReserve: number; dayCap: number; matchCap: number } }>('/agents').catch(() => null);
  const lg = a?.league;
  mount(ui, nav(), h('div', { class: 'panel' },
    h('h2', {}, 'The agents'),
    h('p', { class: 'dim' }, `Each AI chef is a sub-account of the game contract with only a function-call key. The contract caps what it may spend (${lg?.dayCap ?? 150} ryo a day, ${lg?.matchCap ?? 10} per match) and resets the count every UTC day. They claim their faucet, buy cards from the Fixer, and pay Scout Nori for reports on the leader, who then becomes their sabotage target.`),
    h('p', { class: 'dim' }, `The server paces that budget by itself: ${lg?.playerReserve ?? 60} ryo of each chef's day is kept for ranked shifts against people, the rest is spread evenly over the day as ranked league shifts (friendly exhibitions in between), and cards or scout reports only come out of what's spare.${lg ? ` Ranked league shifts still affordable today: ${lg.rankedRoundsLeft}.` : ''}`),
    a?.chefs?.some((c) => c.budget) ? h('ul', { class: 'agents' }, ...a.chefs.map((c) => h('li', {}, h('b', {}, c.name), c.budget ? ` · ${c.budget.left} ryo left today · ${c.budget.forPlayers} kept for your ranked shifts · ${c.budget.leagueEntries} league entries` : ''))) : null,
    h('ul', { class: 'agents' }, ...(cfg?.agents ?? []).map((x) => h('li', {}, h('b', {}, x.name), ' ', h('a', { href: explorerAccount(x.account), target: '_blank' }, x.account), x.chef ? ` · ${x.chef}` : '', x.skill ? ` · ${x.skill}` : ''))),
    h('h3', {}, 'Receipts'),
    a?.storage ? h('p', { class: 'warn' }, `⚠ ${a.storage}`) : null,
    h('p', { class: 'dim' }, 'Each receipt links its transaction. ✗ marks an action that failed onchain: nothing was spent or won.'),
    h('ul', { class: 'acts' }, ...(a?.acts ?? []).map((x) => h('li', { class: x.failed ? 'failed' : '' }, h('small', {}, new Date(x.at).toLocaleTimeString()), ' ', x.failed ? h('b', { class: 'bad' }, '✗ ') : null, h('b', {}, x.who), ` ${x.what} `, x.url ? h('a', { href: x.url, target: '_blank' }, 'tx') : null)))));
}

/** The How to play sheet, from the nav or the title screen. */
function howTo(): void {
  if (modalOpen()) return;
  howToPlay({ inShift: false, replay: () => { title(); welcome(() => solo(3, 'easy')); } });
}

// testing aid: ?debug exposes the scene and the running shift
if (location.search.includes('debug')) Object.defineProperties(window, { kitchen: { value: scene }, shift: { get: () => shift } });
void boot();
