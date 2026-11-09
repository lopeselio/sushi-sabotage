import { randomBytes } from 'node:crypto';
import { CARDS, botAccuse, results, sealOf, sha256Hex, stateHash, type Accusation, type Card, type ChefSetup, type Result, type Setup, type State } from '@sushi/rules';
import { CHEF_AGENTS, agentChef, agentLoadout, scoutedRival, type AgentDef } from './agents.ts';
import { call, view } from './chain.ts';
import { config } from './config.ts';
import { saveMatch, type MatchRecord, type OpeningRec } from './store.ts';

// One match's onchain life: create (fees + loadouts), seals during the shift, settlement.
// Chain calls never block play: if a call fails the match still finishes and the record says why.

export const RANKED_FEE = 10;

export interface SeatPlan {
  name: string;
  kind: 'human' | 'bot' | 'guest';
  account?: string; // signed-in wallet
  chef?: string | null; // chef token
  agent?: AgentDef;
  loadout?: number[]; // counts per card (CARDS order)
}

interface ChefTokenView { owner_id: string; purse: number; kind: { Chef?: { inventory: number[]; approved_fee: number } } }

const newId = (): string => `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

/** Fill in each seat's chef token, clamp loadouts to real inventory, and pick ranked/fee. */
export async function planSeats(seats: SeatPlan[]): Promise<{ seats: SeatPlan[]; fee: number }> {
  const out: SeatPlan[] = [];
  let allApproved = true;
  let anyHumanChef = false;
  for (const s of seats) {
    const p = { ...s };
    if (p.kind === 'bot' && p.agent) p.chef = await agentChef(p.agent);
    if (p.kind === 'human' && p.account && config.chainEnabled) p.chef = await view<string | null>('chef_of', { account_id: p.account }).catch(() => null);
    if (p.chef) {
      const t = await view<ChefTokenView | null>('get_token', { token_id: p.chef }).catch(() => null);
      const inv = t?.kind.Chef?.inventory ?? [];
      p.loadout = p.kind === 'bot' && p.agent ? await agentLoadout(p.agent) : CARDS.map((_, k) => Math.min(p.loadout?.[k] ?? 0, inv[k] ?? 0, 3));
      if ((t?.kind.Chef?.approved_fee ?? 0) < RANKED_FEE || (t?.purse ?? 0) < RANKED_FEE) allApproved = false;
      if (p.kind === 'human') anyHumanChef = true;
    } else {
      p.chef = null;
      p.loadout = [];
      if (p.kind === 'human') p.kind = 'guest';
    }
    out.push(p);
  }
  return { seats: out, fee: anyHumanChef && allApproved ? RANKED_FEE : 0 };
}

export function setupFor(seed: string, seats: SeatPlan[]): Setup {
  const chefs: ChefSetup[] = seats.map((s) => {
    const loadout: Partial<Record<Card, number>> = {};
    (s.loadout ?? []).forEach((n, k) => { if (n > 0) loadout[CARDS[k]] = n; });
    const c: ChefSetup = { name: s.name, loadout };
    if (s.kind === 'bot') {
      c.bot = s.agent?.skill ?? 'normal';
      // a scouted rival who's in this match becomes the bot's preferred target
      const rival = s.agent ? scoutedRival(s.agent) : null;
      const at = rival ? seats.findIndex((x) => x.chef === rival) : -1;
      if (at >= 0) c.rival = at;
    }
    return c;
  });
  return { seed, chefs };
}

export class ChainMatch {
  readonly id = newId();
  readonly seed = randomBytes(16).toString('hex');
  readonly rec: MatchRecord;
  /** the sim setup, built from this match's own secret seed */
  readonly setup: Setup;
  private created: Promise<boolean>;
  private pending: string[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(mode: 'solo' | 'room', readonly seats: SeatPlan[], readonly fee: number) {
    this.setup = setupFor(this.seed, seats);
    this.rec = {
      id: this.id, mode, createdAt: Date.now(), setup: this.setup,
      seats: seats.map((s) => ({ chef: s.chef ?? null, name: s.name, kind: s.kind, account: s.account })),
      seedHash: sha256Hex(this.seed), fee, ranked: fee > 0, log: [], seals: [], openings: [], accusations: [], txs: [], lines: [], settled: false,
    };
    saveMatch(this.rec);
    this.created = this.create();
  }

  private async create(): Promise<boolean> {
    if (!config.chainEnabled) return false;
    try {
      const r = await call(config.referee, 'create_match', {
        match_id: this.id,
        seed_hash: this.rec.seedHash,
        seats: this.seats.map((s) => ({ chef: s.chef ?? null, name: s.name, loadout: s.chef ? (s.loadout?.length ? s.loadout : []) : [] })),
        fee: this.fee,
        ranked: this.fee > 0,
      }, 100);
      this.rec.txs.push({ what: 'create_match', hash: r.tx });
      saveMatch(this.rec);
      return true;
    } catch (e) {
      this.rec.error = `create_match: ${(e as Error).message.slice(0, 300)}`;
      saveMatch(this.rec);
      return false;
    }
  }

  /** Record new sabotages (from s.sab, in cast order) as openings + seals. */
  noteSabotage(s: State): void {
    while (this.rec.openings.length < s.sab.length) {
      const x = s.sab[this.rec.openings.length];
      const o: OpeningRec = { caster: x.caster, target: x.target, card: x.card, tick: x.tick, salt: randomBytes(12).toString('hex') };
      const seal = sealOf({ match: this.id, ...o });
      this.rec.openings.push(o);
      this.rec.seals.push(seal);
      this.pending.push(seal);
    }
  }

  /** Post pending seals onchain (batched). Safe to call often. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (!this.pending.length || !(await this.created)) return;
      const batch = this.pending.splice(0, this.pending.length);
      try {
        const r = await call(config.referee, 'seal', { match_id: this.id, seals: batch });
        this.rec.txs.push({ what: `seal x${batch.length}`, hash: r.tx });
      } catch (e) {
        this.pending.unshift(...batch);
        this.rec.error = `seal: ${(e as Error).message.slice(0, 200)}`;
      }
    });
    return this.flushing;
  }

  /** Bots' accusations for every sabotage that hit a bot. */
  botAccusations(s: State): Accusation[] {
    const out: Accusation[] = [];
    s.sab.forEach((x, k) => {
      if (x.card === 'bamboo_shield' || !s.chefs[x.target].bot) return;
      const a = botAccuse(s, x.target, k);
      if (a !== null) out.push({ victim: x.target, sab: k, accused: a });
    });
    return out;
  }

  /** Score, save and settle onchain. Returns the results at once; the chain part completes in the background. */
  finish(s: State, accusations: Accusation[]): { results: Result[]; settled: Promise<void> } {
    this.noteSabotage(s);
    const res = results(s, accusations);
    this.rec.accusations = accusations;
    this.rec.results = res;
    this.rec.stateHash = stateHash(s);
    this.rec.seed = this.seed;
    saveMatch(this.rec);
    const settled = (async () => {
      await this.flush();
      if (!(await this.created)) return;
      if (this.pending.length) await this.flush();
      try {
        const r = await call(config.referee, 'settle_match', {
          match_id: this.id,
          seed: this.seed,
          openings: this.rec.openings,
          accusations,
          reports: s.chefs.map((c) => ({ score: c.score, dishes: c.dishes, burns: c.burns })),
        }, 200);
        this.rec.txs.push({ what: 'settle_match', hash: r.tx });
        this.rec.settled = true;
      } catch (e) {
        this.rec.error = `settle_match: ${(e as Error).message.slice(0, 300)}`;
      }
      saveMatch(this.rec);
    })();
    return { results: res, settled };
  }
}

/** Default AI opponents for a solo shift, by count. */
export const soloBots = (n: number): AgentDef[] => CHEF_AGENTS.slice(0, Math.max(1, Math.min(3, n)));
