import './style.css';
import { CARD_INFO, CARDS, RECIPES, stateHash, type Card, type LogEntry, type Result, type SimEvent, type State } from '@sushi/rules';
import { api, explorer, explorerAccount, session, type Me, type ServerConfig } from './api.ts';
import { isMuted, setMuted, sfx } from './audio.ts';
import { RoomShift, SoloShift, type Shift } from './game.ts';
import { CHEF_COLORS, KitchenScene } from './scene.ts';
import { $, h, mount, toast } from './ui.ts';
import { call, setContract, signIn, signOut } from './wallet.ts';

const ui = $('#ui');
const hud = $('#hud');
const scene = new KitchenScene($<HTMLCanvasElement>('#c'));
let cfg: ServerConfig | null = null;
let me: Me | null = null;
let shift: Shift | null = null;
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const store = { get name(): string { try { return localStorage.getItem('sushi.name') ?? ''; } catch { return ''; } }, set name(v: string) { try { localStorage.setItem('sushi.name', v); } catch { /* */ } } };

// ---------- boot ----------

async function boot(): Promise<void> {
  mount(ui, h('div', { class: 'panel center' }, h('h1', { class: 'logo' }, 'Sushi Sabotage'), h('p', {}, 'Lighting the lanterns…')));
  await scene.load();
  scene.build(['', '', '', ''], 0);
  scene.overview = true;
  idleLoop();
  cfg = await api<ServerConfig>('/config').catch(() => null);
  if (cfg) setContract(cfg.contract);
  if (session.token) me = await api<Me>('/me').catch(() => { session.set(null); return null; });
  title();
}

function idleLoop(): void {
  let last = performance.now();
  const f = (t: number): void => { if (!shift) scene.render(Math.min(0.1, (t - last) / 1000)); last = t; requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

const chefName = (): string => (me?.raw?.kind.Chef?.name ?? store.name) || 'Chef';

function nav(): HTMLElement {
  return h('nav', { class: 'nav' },
    h('button', { onclick: title }, 'Kitchen'),
    h('button', { onclick: market }, 'Night Market'),
    h('button', { onclick: myChef }, 'My Chef'),
    h('button', { onclick: board }, 'Leaderboard'),
    h('button', { onclick: agents }, 'Agents'),
    h('button', { onclick: howTo }, 'How to play'),
    h('button', { class: 'mute', onclick: (e: Event) => { setMuted(!isMuted()); (e.target as HTMLElement).textContent = isMuted() ? '🔇' : '🔊'; } }, isMuted() ? '🔇' : '🔊'));
}

function walletBadge(): HTMLElement {
  if (me) return h('div', { class: 'wallet' }, h('a', { href: explorerAccount(me.accountId), target: '_blank' }, me.accountId), h('button', { class: 'link', onclick: async () => { await signOut(); me = null; title(); } }, 'sign out'));
  return h('div', { class: 'wallet' }, h('button', { class: 'ghost', onclick: doSignIn }, 'Sign in with NEAR'), h('small', {}, 'optional: guests play free'));
}

async function doSignIn(): Promise<void> {
  try {
    await signIn();
    me = await api<Me>('/me');
    toast(`Signed in as ${me.accountId}`, 'good');
    if (!me.chef) myChef(); else title();
  } catch (e) { toast((e as Error).message, 'bad'); }
}

// ---------- title ----------

function title(): void {
  stopShift();
  scene.overview = true;
  const name = h('input', { value: chefName(), maxlength: 20, placeholder: 'Your chef name', oninput: (e: Event) => { store.name = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9 _-]/g, ''); } });
  let rivals = 3;
  const rivalBtns = h('div', { class: 'seg' }, ...[1, 2, 3].map((n) => h('button', { class: n === rivals ? 'on' : '', onclick: (e: Event) => { rivals = n; [...(e.target as HTMLElement).parentElement!.children].forEach((b, k) => b.classList.toggle('on', k + 1 === n)); } }, `${n} rival${n > 1 ? 's' : ''}`)));
  const code = h('input', { placeholder: 'ROOM', maxlength: 4, class: 'code', oninput: (e: Event) => { (e.target as HTMLInputElement).value = (e.target as HTMLInputElement).value.toUpperCase(); } });
  mount(ui, nav(), h('div', { class: 'panel title' },
    h('h1', { class: 'logo' }, 'Sushi Sabotage'),
    h('p', { class: 'tag' }, 'Roll it, sear it, serve it. Wreck your rivals’ dishes while they cook. Nobody sees who did it until the shift ends.'),
    walletBadge(),
    h('label', {}, 'Chef name', name),
    h('div', { class: 'row' }, h('div', { class: 'col' }, h('h3', {}, 'Solo shift'), h('p', { class: 'dim' }, 'You vs AI chefs with their own NEAR wallets.'), rivalBtns, h('button', { class: 'big', onclick: () => solo(rivals) }, 'Start shift')),
      h('div', { class: 'col' }, h('h3', {}, 'Multiplayer'), h('p', { class: 'dim' }, '2–4 chefs. Fill empty pods with AI.'), h('button', { class: 'big', onclick: () => room({ t: 'create' }) }, 'Create room'), h('div', { class: 'join' }, code, h('button', { onclick: () => room({ t: 'join', code: code.value }) }, 'Join')))),
    h('p', { class: 'foot' }, 'NEAR testnet · contract ', h('a', { href: explorerAccount(cfg?.contract ?? ''), target: '_blank' }, cfg?.contract ?? '…'), ' · part of the NEAR Arcade')));
}

function stopShift(): void { shift?.stop(); shift = null; hud.replaceChildren(); }

function countdown(then: () => void, line?: { who: string; text: string; signed: boolean } | null): void {
  let n = 3;
  const box = h('div', { class: 'count' }, '3');
  mount(ui, h('div', { class: 'panel center' }, line ? h('blockquote', { class: 'taunt' }, `“${line.text}”`, h('cite', {}, `— ${line.who}${line.signed ? ' · signed by a TEE model on NEAR AI' : ''}`)) : null, box));
  sfx.tick();
  const t = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(t); sfx.go(); mount(ui); then(); return; }
    box.textContent = String(n); sfx.tick();
  }, 1000);
}

// ---------- solo ----------

async function solo(rivals: number): Promise<void> {
  try {
    const r = await api<{ matchId: string; setup: { seed: string; chefs: { name: string }[] }; ranked: boolean; fee: number; seedHash: string; line: { who: string; text: string; signed: boolean } | null }>('/solo/start', { name: chefName(), bots: rivals, loadout: loadoutChoice() });
    scene.overview = false;
    countdown(() => {
      shift = new SoloShift(scene, r.setup as never, hud, async ({ state, log }) => {
        setTimeout(() => void soloEnd(r.matchId, state, log, r.ranked), 900);
      });
    }, r.line);
  } catch (e) { toast((e as Error).message, 'bad'); }
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
  mount(ui, h('div', { class: 'panel center' }, h('h2', {}, 'Shift over!'), h('p', {}, 'The referee is re-running your shift to check it…')));
  try {
    const r = await api<ResultsMsg>('/solo/finish', { matchId, log, stateHash: stateHash(state), accusations });
    results({ ...r, txs: [], names, you: 0, solo: true });
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
  sock.onopen = () => { sock.send(JSON.stringify({ t: 'hello', session: session.token, name: chefName() })); sock.send(JSON.stringify(first)); };
  sock.onclose = () => { if (ws === sock && shift instanceof RoomShift && !shift.ended) { toast('Disconnected from the kitchen', 'bad'); title(); } };
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Record<string, unknown> & { t: string };
    switch (m.t) {
      case 'error': toast(String(m.msg), 'bad'); break;
      case 'kicked': toast('The host removed you', 'bad'); title(); break;
      case 'room': lobby(sock, m as unknown as LobbyMsg); break;
      case 'start': names = m.names as string[]; you = m.you as number; scene.overview = false; countdown(() => { shift = new RoomShift(scene, you, names, hud, sock); }); break;
      case 'line': toast(`${m.who}: “${m.text}”`); break;
      case 'snap': if (shift instanceof RoomShift) shift.snapshot(m.s as State, m.ev as SimEvent[]); break;
      case 'whodunit': if (shift) shift.ended = true; stopShift(); scene.overview = true; whodunit(sock, m as unknown as WhoMsg, you); break;
      case 'results': results({ ...(m as unknown as ResultsMsg), names, you }); break;
    }
  };
}

interface LobbyMsg { code: string; phase: string; seats: { name: string; kind: string; ready: boolean; signedIn: boolean; here: boolean }[]; you: number; host: boolean }
function lobby(sock: WebSocket, m: LobbyMsg): void {
  if (m.phase !== 'lobby') return;
  const mine = m.seats[m.you];
  mount(ui, nav(), h('div', { class: 'panel' },
    h('h2', {}, 'Room ', h('span', { class: 'roomcode' }, m.code)),
    h('p', { class: 'dim' }, 'Share the code. Everyone presses Ready to start. Empty pods stay empty unless the host adds an AI chef.'),
    h('ul', { class: 'seats' }, ...m.seats.map((s, i) => h('li', { style: `--c:${hex(CHEF_COLORS[i % 4])}` }, h('span', { class: 'dot' }), h('b', {}, s.name), h('small', {}, s.kind === 'bot' ? 'AI chef · own NEAR wallet' : s.signedIn ? 'NEAR wallet' : 'guest'), s.ready ? h('em', {}, 'ready') : h('em', { class: 'dim' }, 'not ready'),
      m.host && i !== m.you ? h('button', { class: 'link', onclick: () => sock.send(JSON.stringify({ t: 'kick', seat: i })) }, 'remove') : null))),
    h('div', { class: 'row' },
      m.host && m.seats.length < 4 ? h('button', { onclick: () => sock.send(JSON.stringify({ t: 'addBot' })) }, 'Add AI chef') : null,
      h('button', { class: 'big', onclick: () => sock.send(JSON.stringify({ t: 'ready', ready: !mine.ready, loadout: loadoutChoice() })) }, mine.ready ? 'Not ready' : 'Ready'),
      h('button', { class: 'ghost', onclick: () => { sock.send(JSON.stringify({ t: 'leave' })); sock.close(); title(); } }, 'Leave'))));
}

interface WhoMsg { hits: { sab: number; card: Card; tick: number; blocked: boolean }[]; until: number; names: string[] }
function whodunit(sock: WebSocket, m: WhoMsg, you: number): void {
  if (!m.hits.length) { mount(ui, h('div', { class: 'panel center' }, h('h2', {}, 'Whodunit'), h('p', {}, 'Nobody sabotaged you this shift. Waiting for the others to accuse…'))); return; }
  whodunitPanel(m, you, (list) => { sock.send(JSON.stringify({ t: 'accuse', list })); mount(ui, h('div', { class: 'panel center' }, h('h2', {}, 'Accusations sealed'), h('p', {}, 'Waiting for the reveal…'))); });
}

/** The accusation screen, shared by multiplayer (sent over the socket) and solo (sent with the log). */
function whodunitPanel(m: WhoMsg, you: number, submit: (list: { sab: number; accused: number }[]) => void, note?: string): void {
  const picks = new Map<number, number>();
  let sent = false;
  const send = (): void => { if (sent) return; sent = true; clearInterval(iv); submit([...picks].map(([sab, accused]) => ({ sab, accused }))); };
  const timer = h('span', { class: 'dim' });
  // when time runs out, whatever you picked is sealed (unpicked hits count as a pass)
  const iv = setInterval(() => { const s = Math.max(0, Math.ceil((m.until - Date.now()) / 1000)); timer.textContent = `${s}s`; if (s <= 0) send(); }, 250);
  mount(ui, h('div', { class: 'panel' },
    h('h2', {}, 'Whodunit? ', timer),
    h('p', { class: 'dim' }, note ?? 'For each sabotage that hit you, name the culprit. Right: +40 to you, −40 to them. Wrong: −10. The seals open onchain next.'),
    h('div', { class: 'hits' }, ...m.hits.map((x) => h('div', { class: 'hit' },
      h('b', {}, CARD_INFO[x.card].name), h('small', {}, ` at ${Math.floor(x.tick / 20)}s${x.blocked ? ' (blocked)' : ''}`),
      h('div', { class: 'seg' }, ...m.names.map((n, i) => (i === you ? null : h('button', { onclick: (e: Event) => { picks.set(x.sab, i); [...(e.target as HTMLElement).parentElement!.children].forEach((b) => b.classList.remove('on')); (e.target as HTMLElement).classList.add('on'); } }, n))), h('button', { class: 'on', onclick: (e: Event) => { picks.delete(x.sab); [...(e.target as HTMLElement).parentElement!.children].forEach((b) => b.classList.remove('on')); (e.target as HTMLElement).classList.add('on'); } }, 'pass'))))),
    h('button', { class: 'big', onclick: send }, 'Seal my accusations')));
}

interface ResultsMsg { verified?: boolean; stateHash?: string; results: Result[]; reveal: { caster: number; target: number; card: Card; tick: number; blocked: boolean; fizzled: boolean }[]; accusations: { victim: number; sab: number; accused: number }[]; matchId: string; txs: { what: string; hash: string; url?: string }[]; ranked: boolean; error?: string }
function results(r: ResultsMsg & { names: string[]; you: number; solo?: boolean }): void {
  stopShift();
  scene.overview = true;
  const sorted = [...r.results].sort((a, b) => a.rank - b.rank);
  const accused = new Map(r.accusations.map((a) => [a.sab, a]));
  const won = sorted[0]?.chef === r.you;
  if (won) sfx.deliver();
  mount(ui, nav(), h('div', { class: 'panel results' },
    h('h2', {}, won ? 'You ran the best kitchen tonight!' : 'Shift results'),
    h('table', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Chef'), h('th', {}, 'Shift'), h('th', {}, 'Whodunit'), h('th', {}, 'Final')),
      ...sorted.map((x) => h('tr', { class: x.chef === r.you ? 'you' : '' }, h('td', {}, String(x.rank)), h('td', { style: `color:${hex(CHEF_COLORS[x.chef % 4])}` }, x.name), h('td', {}, String(x.shiftScore)), h('td', {}, x.accuseDelta ? (x.accuseDelta > 0 ? `+${x.accuseDelta}` : String(x.accuseDelta)) : '—'), h('td', {}, h('b', {}, String(x.final)))))),
    h('h3', {}, 'The sealed sabotage log, opened'),
    r.reveal.length ? h('ul', { class: 'reveal' }, ...r.reveal.map((x, k) => {
      const a = accused.get(k);
      return h('li', {}, h('b', { style: `color:${hex(CHEF_COLORS[x.caster % 4])}` }, r.names[x.caster] ?? `#${x.caster}`), ` played ${CARD_INFO[x.card].name}`, CARD_INFO[x.card].self ? '' : ` on ${r.names[x.target]}`, ` at ${Math.floor(x.tick / 20)}s`, x.blocked ? ' (blocked)' : x.fizzled ? ' (fizzled)' : '',
        a ? h('span', { class: a.accused === x.caster ? 'good' : 'bad' }, ` — ${r.names[a.victim]} accused ${r.names[a.accused]}${a.accused === x.caster ? ' ✓' : ' ✗'}`) : null);
    })) : h('p', { class: 'dim' }, 'Nobody played a card.'),
    r.solo ? h('p', { class: r.verified ? 'good' : 'bad' }, r.verified ? `✓ The referee re-ran your shift from the input log and reached the same state (${r.stateHash?.slice(0, 12)}…).` : '✗ The referee’s replay did not match your browser; the referee’s result stands.') : null,
    r.solo ? h('p', { class: 'dim' }, r.ranked ? 'Ranked solo: your browser ran the sim, so only the AI chefs’ accusations score. In multiplayer the server never tells anyone who cast what.' : 'Solo, unranked: your accusations scored. In multiplayer the server never tells anyone who cast what.') : null,
    h('div', { class: 'proof', id: 'proof' }, proofLinks(r)),
    h('div', { class: 'row' }, h('button', { class: 'big', onclick: title }, 'Back to the kitchen'), h('a', { class: 'btn ghost', href: `/api/match/${r.matchId}`, target: '_blank' }, 'Proof bundle (JSON)'))));
}

function proofLinks(r: { txs: { what: string; hash: string; url?: string }[]; ranked: boolean; error?: string; matchId: string }): HTMLElement {
  return h('div', {},
    h('p', { class: 'dim' }, r.ranked ? 'Ranked: entry fees went into the pot; prizes and recipe-scroll royalties are paid by the contract.' : 'Unranked (no entry fee). Stats still land on chef NFTs.'),
    r.txs.length ? h('ul', { class: 'txs' }, ...r.txs.map((t) => h('li', {}, h('a', { href: t.url ?? explorer(t.hash), target: '_blank' }, t.what), ' ', h('code', {}, `${t.hash.slice(0, 10)}…`)))) : h('p', { class: 'dim' }, 'Settling onchain…'),
    r.error ? h('p', { class: 'bad' }, r.error) : null);
}

function pollTxs(matchId: string, tries = 0): void {
  setTimeout(async () => {
    const m = await api<{ txs: { what: string; hash: string; url: string }[]; settled: boolean; ranked: boolean; error?: string }>(`/match/${matchId}`).catch(() => null);
    const box = document.getElementById('proof');
    if (!m || !box) return;
    box.replaceChildren(proofLinks({ ...m, matchId }));
    if (!m.settled && !m.error && tries < 20) pollTxs(matchId, tries + 1);
  }, 3000);
}

// ---------- the Night Market (the Fixer) ----------

async function market(): Promise<void> {
  stopShift();
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
        const res = await call<number>('accept_offer', { offer_id: r.offer.offerId });
        say('Receipt', `You bought ${CARD_INFO[card].name} for ${r.outcome.price} ryo. Tx ${res.tx.slice(0, 10)}…`, 'sys');
        me = await api<Me>('/me');
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
  if (!me) {
    mount(ui, nav(), h('div', { class: 'panel center' }, h('h2', {}, 'Your Chef NFT'),
      h('p', {}, 'Sign in with a NEAR testnet wallet to mint a free Chef NFT. Its purse, card inventory and record live on the token itself: sell the chef and they go with it.'), walletBadge()));
    return;
  }
  if (!me.chef) {
    const name = h('input', { value: store.name || 'Chef', maxlength: 20 });
    mount(ui, nav(), h('div', { class: 'panel center' }, h('h2', {}, 'Mint your chef'), h('p', {}, 'Free. Starts with 100 ryo. No gas prompts: your wallet’s game key signs it.'), name,
      h('button', { class: 'big', onclick: async () => { try { const r = await call<string>('mint_chef', { name: name.value.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20) || 'Chef' }); toast(`Minted ${r.value}`, 'good'); me = await api<Me>('/me'); myChef(); } catch (e) { toast((e as Error).message, 'bad'); } } }, 'Mint chef')));
    return;
  }
  const t = me.token!;
  const raw = me.raw!;
  const extra = JSON.parse(t.metadata.extra) as { level: number; title: string; stats: Record<string, number> };
  const owned = await fetchOwned().catch(() => []);
  const act = (label: string, fn: () => Promise<unknown>): HTMLElement => h('button', { onclick: async () => { try { await fn(); toast(`${label}: done`, 'good'); me = await api<Me>('/me'); myChef(); } catch (e) { toast((e as Error).message, 'bad'); } } }, label);
  mount(ui, nav(), h('div', { class: 'panel chef' },
    h('div', { class: 'nft' }, h('img', { src: t.metadata.media, alt: t.metadata.title })),
    h('div', {},
      h('h2', {}, t.metadata.title),
      h('p', { class: 'dim' }, t.metadata.description),
      h('p', {}, `Purse ${raw.purse} ryo · Level ${extra.level} ${extra.title} · ranked fee approval: ${raw.kind.Chef?.approved_fee ?? 0} ryo`),
      h('p', {}, `Cards: ${CARDS.map((c, k) => `${CARD_INFO[c].name} ×${raw.kind.Chef?.inventory[k] ?? 0}`).join(' · ')}`),
      h('div', { class: 'row' },
        act('Claim daily 50 ryo', () => call('claim_daily', { chef: me!.chef })),
        act('Enable ranked (10 ryo/match)', () => call('approve_referee', { chef: me!.chef, max_fee: 10 })),
        act('Disable ranked', () => call('approve_referee', { chef: me!.chef, max_fee: 0 }))),
      h('h3', {}, 'Your tokens'),
      h('div', { class: 'owned' }, ...owned.map((o) => h('div', { class: 'tok' }, h('img', { src: o.metadata.media }), h('small', {}, o.metadata.title)))),
      h('p', { class: 'dim' }, 'Recipe Scrolls earn 2 ryo from the pot every time anyone serves their recipe in a ranked match. Move a scroll’s earnings into your chef with move_purse.'))));
}

async function fetchOwned(): Promise<{ token_id: string; metadata: { title: string; media: string; description: string } }[]> {
  if (!me || !cfg) return [];
  const res = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: cfg.contract, method_name: 'nft_tokens_for_owner', args_base64: btoa(JSON.stringify({ account_id: me.accountId })) } }) });
  const j = (await res.json()) as { result?: { result: number[] } };
  return j.result ? JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) : [];
}

// ---------- leaderboard, agents, how to play ----------

async function board(): Promise<void> {
  stopShift();
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
  const a = await api<{ acts: { at: number; who: string; what: string; url?: string }[]; chefs: { name: string; account: string; skill: string }[] }>('/agents').catch(() => null);
  mount(ui, nav(), h('div', { class: 'panel' },
    h('h2', {}, 'The agents'),
    h('p', { class: 'dim' }, 'Each AI chef is a sub-account of the game contract with only a function-call key. The contract caps what it may spend (60 ryo a day, 10 per match). They claim their faucet, buy cards from the Fixer, and pay Scout Nori for reports on the leader, who then becomes their sabotage target.'),
    h('ul', { class: 'agents' }, ...(cfg?.agents ?? []).map((x) => h('li', {}, h('b', {}, x.name), ' ', h('a', { href: explorerAccount(x.account), target: '_blank' }, x.account), x.chef ? ` · ${x.chef}` : '', x.skill ? ` · ${x.skill}` : ''))),
    h('h3', {}, 'Receipts'),
    h('ul', { class: 'acts' }, ...(a?.acts ?? []).map((x) => h('li', {}, h('small', {}, new Date(x.at).toLocaleTimeString()), ' ', h('b', {}, x.who), ` ${x.what} `, x.url ? h('a', { href: x.url, target: '_blank' }, 'tx') : null)))));
}

function howTo(): void {
  stopShift();
  mount(ui, nav(), h('div', { class: 'panel howto' },
    h('h2', {}, 'How to play'),
    h('p', {}, h('b', {}, 'Move'), ' WASD/arrows · ', h('b', {}, 'Pick up / place'), ' E or Space · ', h('b', {}, 'Chop'), ' F (tap repeatedly) · ', h('b', {}, 'Cards'), ' 1–6 · ', h('b', {}, 'Target'), ' Tab · ', h('b', {}, 'See all kitchens'), ' V'),
    h('ul', {},
      h('li', {}, 'Every dish = sushi rice + a base (nori roll for maki, cone for temaki) + seared fish or lobster + extras.'),
      h('li', {}, 'Rice: cooker (3s) → board (3 chops). Fish/lobster: board → pan (3s, burns 5s later!). Tomato: board → pan. Avocado: 5 chops. Wasabi: board = slices; slices → pot (10s) = chutney. Nori sheet: 3 chops = roll. Cones need no prep.'),
      h('li', {}, 'Grab a plate from the rack, put it on a counter, add ingredients, then carry it to the hatch.'),
      h('li', {}, 'Deliveries charge your Mischief. Spend it on cards against a rival. They see the effect, never the culprit, until the seals open.'),
      h('li', {}, 'After the shift: accuse. Right +40 (they lose 40), wrong −10.')),
    h('h3', {}, 'The 20 recipes'),
    h('div', { class: 'recipes' }, ...RECIPES.map((r) => h('div', {}, h('b', {}, r.name), h('small', {}, ` ${r.style} · ${r.protein}${r.depth ? ` + ${r.depth}` : ''}`))))));
}

if (location.search.includes("debug")) (window as unknown as { kitchen: unknown }).kitchen = scene;
void boot();
