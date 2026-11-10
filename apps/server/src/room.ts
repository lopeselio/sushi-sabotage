import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CARDS, DIFFICULTIES, MAX_CHEFS, SHIFT_TICKS, TICK_HZ, createState, step, viewFor,
  type Accusation, type BotSkill, type Input, type Result, type SimEvent, type State,
} from '@sushi/rules';
import { CHEF_AGENTS, taunt, type AgentDef } from './agents.ts';
import { ChainMatch, planSeats, type SeatPlan } from './match.ts';
import { explorerTx } from './config.ts';

// Multiplayer rooms. The server runs the sim; clients send inputs and get their own view.
// The caster of a sabotage is never sent to anyone but the caster.

type Phase = 'lobby' | 'countdown' | 'playing' | 'whodunit' | 'results';

interface Member {
  ws: WebSocket | null;
  name: string;
  account: string | null;
  ready: boolean;
  bot: AgentDef | null;
  loadout: number[];
  inputs: Input[];
  sent: number; // messages this tick (flood guard)
}

const rooms = new Map<string, Room>();
const COUNTDOWN_MS = 3000;
const WHODUNIT_MS = 20_000;
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function code(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const c = Array.from(randomBytes(4), (b) => A[b % A.length]).join('');
    if (!rooms.has(c)) return c;
  }
}

export class Room {
  readonly code = code();
  phase: Phase = 'lobby';
  /** AI chef difficulty, picked by the host in the lobby */
  difficulty: BotSkill = 'normal';
  members: Member[] = [];
  private state: State | null = null;
  private match: ChainMatch | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evBuf: SimEvent[][] = [];
  private accusations = new Map<number, Accusation[]>();
  private resultsMsg: unknown = null;
  private lastFlush = 0;

  constructor() { rooms.set(this.code, this); }

  static get(c: string): Room | undefined { return rooms.get(c.toUpperCase()); }
  static list(): { code: string; players: number; phase: Phase }[] {
    return [...rooms.values()].filter((r) => r.phase === 'lobby').map((r) => ({ code: r.code, players: r.members.length, phase: r.phase }));
  }

  get hostIdx(): number { return this.members.findIndex((m) => !m.bot && m.ws); }

  join(ws: WebSocket, name: string, account: string | null): number {
    if (this.phase !== 'lobby') throw new Error('that shift has already started');
    if (this.members.length >= MAX_CHEFS) throw new Error('the room is full');
    if (account && this.members.some((m) => m.account === account)) throw new Error('you are already in this room');
    this.members.push({ ws, name: name.slice(0, 20) || 'Chef', account, ready: false, bot: null, loadout: [], inputs: [], sent: 0 });
    this.broadcastRoom();
    return this.members.length - 1;
  }

  addBot(by: WebSocket): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx) return;
    if (this.members.length >= MAX_CHEFS) return;
    const used = new Set(this.members.map((m) => m.bot?.label));
    const a = CHEF_AGENTS.find((x) => !used.has(x.label));
    if (!a) return;
    this.members.push({ ws: null, name: a.name, account: null, ready: true, bot: a, loadout: [], inputs: [], sent: 0 });
    this.broadcastRoom();
  }

  setDifficulty(by: WebSocket, level: string): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx) return;
    const d = DIFFICULTIES.find((x) => x === level);
    if (!d) return;
    this.difficulty = d;
    this.broadcastRoom();
  }

  kick(by: WebSocket, seat: number): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx || seat === this.hostIdx) return;
    const m = this.members[seat];
    if (!m) return;
    send(m.ws, { t: 'kicked' });
    this.members.splice(seat, 1);
    this.broadcastRoom();
  }

  seatOf(ws: WebSocket): number { return this.members.findIndex((m) => m.ws === ws); }

  setReady(ws: WebSocket, ready: boolean, loadout: number[] = []): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'lobby') return;
    this.members[i].ready = ready;
    this.members[i].loadout = CARDS.map((_, k) => Math.max(0, Math.min(3, Math.floor(loadout[k] ?? 0))));
    this.broadcastRoom();
    if (this.members.length >= 1 && this.members.every((m) => m.ready) && this.members.some((m) => !m.bot)) void this.start();
  }

  leave(ws: WebSocket): void {
    const i = this.seatOf(ws);
    if (i < 0) return;
    const m = this.members[i];
    if (this.phase === 'lobby') {
      this.members.splice(i, 1);
    } else {
      // mid-shift: an AI chef takes over the pod so the match stays fair for everyone else
      m.ws = null;
      if (this.state && this.phase === 'playing' && !this.state.chefs[i].bot) m.inputs.push({ takeover: this.difficulty });
    }
    if (!this.members.some((x) => x.ws)) { this.stop(); rooms.delete(this.code); return; }
    this.broadcastRoom();
  }

  input(ws: WebSocket, inp: Input): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing') return;
    const m = this.members[i];
    if (++m.sent > 8 || inp.takeover) return;
    const clean: Input = {};
    if (inp.mx === -1 || inp.mx === 0 || inp.mx === 1) clean.mx = inp.mx;
    if (inp.mz === -1 || inp.mz === 0 || inp.mz === 1) clean.mz = inp.mz;
    if (inp.act) clean.act = true;
    if (inp.chop) clean.chop = true;
    if (inp.card && (CARDS as readonly string[]).includes(inp.card) && Number.isInteger(inp.target)) { clean.card = inp.card; clean.target = inp.target; }
    m.inputs.push(clean);
  }

  accuse(ws: WebSocket, list: { sab: number; accused: number }[]): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'whodunit' || !this.state) return;
    const mine = list
      .filter((a) => this.state!.sab[a.sab]?.target === i && a.accused !== i)
      .slice(0, 64)
      .map((a) => ({ victim: i, sab: a.sab, accused: a.accused }));
    this.accusations.set(i, mine);
    const waiting = this.members.some((m, k) => !m.bot && m.ws && !this.accusations.has(k) && this.hitsFor(k).length > 0);
    if (!waiting) this.finish();
  }

  private hitsFor(i: number): { sab: number; card: string; tick: number; blocked: boolean }[] {
    return (this.state?.sab ?? []).map((x, k) => ({ x, k })).filter(({ x }) => x.target === i && x.card !== 'bamboo_shield')
      .map(({ x, k }) => ({ sab: k, card: x.card, tick: x.tick, blocked: x.blocked }));
  }

  private broadcastRoom(): void {
    const seats = this.members.map((m) => ({ name: m.name, kind: m.bot ? 'bot' : 'human', ready: m.ready, signedIn: !!m.account, here: !!m.ws || !!m.bot }));
    this.members.forEach((m, i) => send(m.ws, { t: 'room', code: this.code, phase: this.phase, difficulty: this.difficulty, seats, you: i, host: i === this.hostIdx }));
  }

  private async start(): Promise<void> {
    if (this.phase !== 'lobby') return;
    this.phase = 'countdown';
    this.broadcastRoom();
    const plans: SeatPlan[] = this.members.map((m) => (m.bot
      ? { name: m.name, kind: 'bot', agent: m.bot }
      : { name: m.name, kind: m.account ? 'human' : 'guest', account: m.account ?? undefined, loadout: m.loadout }));
    const { seats, fee } = await planSeats(plans);
    // the match's secret seed drives the orders; only its hash goes onchain at create
    const match = new ChainMatch('room', seats, fee, this.difficulty);
    this.match = match;
    this.state = createState(match.setup);
    const startsAt = Date.now() + COUNTDOWN_MS;
    this.members.forEach((m, i) => send(m.ws, { t: 'start', you: i, matchId: match.id, startsAt, names: seats.map((s) => s.name), difficulty: this.difficulty, ranked: fee > 0, fee, seedHash: match.rec.seedHash }));
    // one AI chef taunts (TEE-signed line), without holding up the countdown
    const bot = this.members.find((m) => m.bot)?.bot;
    if (bot) void taunt(bot, seats.filter((s) => s.agent !== bot).map((s) => s.name)).then((line) => { match.rec.lines.push(line); this.members.forEach((m) => send(m.ws, { t: 'line', who: line.who, text: line.text, signed: !!line.signature })); });
    setTimeout(() => this.play(), COUNTDOWN_MS);
  }

  private play(): void {
    if (!this.state || !this.match) return;
    this.phase = 'playing';
    let next = Date.now();
    const tick = (): void => {
      const s = this.state!;
      const inputs: (Input | undefined)[] = this.members.map((m) => {
        if (!m.inputs.length) return undefined;
        const merged = m.inputs.reduce<Input>((a, b) => ({ ...a, ...b, act: a.act || b.act, chop: a.chop || b.chop }), {});
        m.inputs = [];
        return merged;
      });
      this.members.forEach((m, i) => { m.sent = 0; if (inputs[i]) this.match!.rec.log.push({ t: s.tick, c: i, i: inputs[i]! }); });
      const ev = step(s, inputs);
      this.evBuf.push(ev);
      this.match!.noteSabotage(s);
      if (Date.now() - this.lastFlush > 3000) { this.lastFlush = Date.now(); void this.match!.flush(); }
      if (s.tick % 2 === 0 || s.over) this.snapshot();
      if (s.over) { this.stop(); this.whodunit(); return; }
      next += 1000 / TICK_HZ;
      this.timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    tick();
  }

  private snapshot(): void {
    const s = this.state!;
    const evs = this.evBuf.flat();
    this.evBuf = [];
    this.members.forEach((m, i) => {
      if (!m.ws) return;
      // casters are hidden from everyone but themselves
      const ev = evs.map((e) => (e.t === 'sabotaged' && e.caster !== i ? { ...e, caster: -1 } : e)).filter((e) => e.t !== 'cast' || e.caster === i);
      send(m.ws, { t: 'snap', s: viewFor(s, i), ev, left: SHIFT_TICKS - s.tick });
    });
  }

  private whodunit(): void {
    this.phase = 'whodunit';
    void this.match!.flush();
    const until = Date.now() + WHODUNIT_MS;
    let anyone = false;
    this.members.forEach((m, i) => {
      const hits = this.hitsFor(i);
      if (!m.bot && m.ws && hits.length) anyone = true;
      send(m.ws, { t: 'whodunit', hits, until, names: this.state!.chefs.map((c) => c.name) });
    });
    if (!anyone) { this.finish(); return; }
    this.timer = setTimeout(() => this.finish(), WHODUNIT_MS);
  }

  private finish(): void {
    if (this.phase !== 'whodunit' || !this.state || !this.match) return;
    this.stop();
    this.phase = 'results';
    const s = this.state;
    const acc = [...this.match.botAccusations(s), ...[...this.accusations.values()].flat()];
    const { results, settled } = this.match.finish(s, acc);
    const reveal = s.sab.map((x) => ({ caster: x.caster, target: x.target, card: x.card, tick: x.tick, blocked: x.blocked, fizzled: x.fizzled }));
    const msg = (txs: { what: string; hash: string }[]): unknown => ({ t: 'results', results, reveal, accusations: acc, matchId: this.match!.id, difficulty: this.members.some((m) => m.bot) ? this.difficulty : undefined, txs: txs.map((x) => ({ ...x, url: explorerTx(x.hash) })), ranked: this.match!.rec.ranked, error: this.match!.rec.error });
    this.resultsMsg = msg(this.match.rec.txs);
    this.members.forEach((m) => send(m.ws, this.resultsMsg));
    void settled.then(() => { this.resultsMsg = msg(this.match!.rec.txs); this.members.forEach((m) => send(m.ws, this.resultsMsg)); setTimeout(() => rooms.delete(this.code), 10 * 60_000); });
  }

  private stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

export type { Result };
