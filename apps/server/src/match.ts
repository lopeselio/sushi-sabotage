import { randomBytes } from 'node:crypto';
import { CARDS, RANKED_GEAR_CAP, RULES_VERSION, botAccuse, gearFromArray, gearToArray, results, sealOf, sha256Hex, stateHash, taggedSeed, type Accusation, type BotSkill, type Card, type ChefSetup, type Result, type Setup, type State } from '@sushi/rules';
import { CHEF_AGENTS, agentChef, agentLoadout, scoutedRival, type AgentDef } from './agents.ts';
import { call, view } from './chain.ts';
import { budgetOf } from './budget.ts';
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
  gear?: number[]; // the chef NFT's upgrade levels (knife, pan, sandals, apron), capped in ranked
  /** a signed-in chef with too little energy: plays as a guest seat, nothing recorded */
  noEnergy?: boolean;
}

/** A chef's energy and gear, from the contract (econ.rs). */
export interface ChefEcon { chef: string; level: number; energy: number; energy_max: number; energy_per_shift: number; next_energy_secs: number; gear: number[]; can_play: boolean }

interface ChefTokenView { owner_id: string; purse: number; kind: { Chef?: { inventory: number[]; approved_fee: number } } }

const newId = (): string => `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

interface AgentView { chef: string; day_cap: number; match_cap: number; day: number; spent_today: number }

/**
 * Whether an agent can pay `fee` today. Against people it may use its whole remaining allowance
 * (including the player reserve); in the league it may only use the league budget (budget.ts).
 */
async function agentCanPay(a: AgentDef, fee: number, league = false): Promise<boolean> {
  const acct = `${a.label}.${config.contract}`;
  const p = await view<AgentView | null>('get_agent', { account_id: acct }).catch(() => null);
  if (!p) return false;
  // the contract counts days in nanoseconds since epoch / 1 day
  const today = Math.floor(Date.now() / 86_400_000);
  const spent = p.day === today ? p.spent_today : 0;
  if (fee > p.match_cap) return false;
  return league ? budgetOf(p, Date.now(), fee).leagueEntries >= 1 : spent + fee <= p.day_cap;
}

/**
 * Fill in each seat's chef token, clamp loadouts to real inventory, and pick ranked/fee.
 * A match is ranked (fee into the pot) only if every chef seat can pay: approved by its owner,
 * enough in the purse, and, for AI chefs, inside today's spending cap. League matches can be
 * ranked with no human in them.
 */
export async function planSeats(seats: SeatPlan[], opts: { league?: boolean; friendly?: boolean } = {}): Promise<{ seats: SeatPlan[]; fee: number }> {
  const out: SeatPlan[] = [];
  let allApproved = true;
  let anyHumanChef = false;
  for (const s of seats) {
    const p = { ...s };
    if (p.kind === 'bot' && p.agent) p.chef = await agentChef(p.agent);
    if (p.kind === 'human' && p.account && config.chainEnabled) p.chef = await view<string | null>('chef_of', { account_id: p.account }).catch(() => null);
    if (p.kind === 'human' && p.chef) {
      // a shift costs the chef energy (the contract takes it at create_match); without enough, it's a guest shift
      const econ = await view<ChefEcon | null>('get_chef', { chef: p.chef }).catch(() => null);
      if (econ && !econ.can_play) { p.chef = null; p.noEnergy = true; }
      else if (econ?.gear.some((l) => l > 0)) p.gear = econ.gear;
    }
    if (p.chef) {
      const t = await view<ChefTokenView | null>('get_token', { token_id: p.chef }).catch(() => null);
      const inv = t?.kind.Chef?.inventory ?? [];
      p.loadout = p.kind === 'bot' && p.agent ? await agentLoadout(p.agent) : CARDS.map((_, k) => Math.min(p.loadout?.[k] ?? 0, inv[k] ?? 0, 3));
      if ((t?.kind.Chef?.approved_fee ?? 0) < RANKED_FEE || (t?.purse ?? 0) < RANKED_FEE) allApproved = false;
      if (p.kind === 'bot' && p.agent && !(await agentCanPay(p.agent, RANKED_FEE, !!opts.league))) allApproved = false;
      if (p.kind === 'human') anyHumanChef = true;
    } else {
      p.chef = null;
      p.loadout = [];
      if (p.kind === 'human') p.kind = 'guest';
    }
    out.push(p);
  }
  const fee = !opts.friendly && (anyHumanChef || opts.league) && allApproved && out.some((x) => x.chef) ? RANKED_FEE : 0;
  // ranked shifts count each upgrade up to level 3 (the contract checks the same cap)
  if (fee > 0) for (const p of out) if (p.gear) p.gear = p.gear.map((l) => Math.min(l, RANKED_GEAR_CAP));
  return { seats: out, fee };
}

/**
 * The sim setup. With a difficulty (solo shifts and rooms) it's a rules-v2 match and every AI chef
 * plays at that level; without one (the AI league) it's rules v1 and each chef plays at its own
 * persona skill, exactly as before.
 */
export function setupFor(seed: string, seats: SeatPlan[], difficulty?: BotSkill): Setup {
  const chefs: ChefSetup[] = seats.map((s) => {
    const loadout: Partial<Record<Card, number>> = {};
    (s.loadout ?? []).forEach((n, k) => { if (n > 0) loadout[CARDS[k]] = n; });
    const c: ChefSetup = { name: s.name, loadout };
    // upgrades are a rules-v3 thing (solo and rooms); the league (v1) has none
    if (difficulty && s.chef && s.gear?.some((l) => l > 0)) c.gear = gearFromArray(s.gear);
    if (s.kind === 'bot') {
      c.bot = difficulty ?? s.agent?.skill ?? 'normal';
      // a scouted rival who's in this match becomes the bot's preferred target
      const rival = s.agent ? scoutedRival(s.agent) : null;
      const at = rival ? seats.findIndex((x) => x.chef === rival) : -1;
      if (at >= 0) c.rival = at;
    }
    return c;
  });
  return difficulty ? { seed, chefs, rulesVersion: RULES_VERSION, difficulty } : { seed, chefs };
}

export class ChainMatch {
  readonly id = newId();
  /** the secret seed; it also names the rules version and difficulty, so its hash commits to them */
  readonly seed: string;
  readonly rec: MatchRecord;
  /** the sim setup, built from this match's own secret seed */
  readonly setup: Setup;
  private created: Promise<boolean>;
  private pending: string[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(mode: MatchRecord['mode'], readonly seats: SeatPlan[], readonly fee: number, readonly difficulty?: BotSkill) {
    const hex = randomBytes(16).toString('hex');
    this.seed = difficulty ? taggedSeed(hex, difficulty) : hex;
    this.setup = setupFor(this.seed, seats, difficulty);
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
        // each seat's gear, checked by the contract against the chef NFT and recorded for verify
        gear: this.setup.chefs.some((c) => c.gear) ? this.setup.chefs.map((c) => gearToArray(c.gear)) : null,
      }, 100);
      this.rec.txs.push({ what: 'create_match', hash: r.tx });
      saveMatch(this.rec);
      return true;
    } catch (e) {
      // a send that timed out may still have landed: if the contract holds this match, it was created
      if (await this.onchain((m) => m.seed_hash === this.rec.seedHash)) return true;
      this.rec.error = `create_match: ${(e as Error).message.slice(0, 300)}`;
      saveMatch(this.rec);
      return false;
    }
  }

  /** Whether the contract's record of this match passes `test` (after a call whose outcome is unknown). */
  private async onchain(test: (m: { seed_hash: string; settled: boolean }) => boolean): Promise<boolean> {
    const m = await view<{ seed_hash: string; settled: boolean } | null>('get_match', { match_id: this.id }).catch(() => null);
    return !!m && test(m);
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
        if (await this.onchain((m) => m.settled)) this.rec.settled = true;
        else this.rec.error = `settle_match: ${(e as Error).message.slice(0, 300)}`;
      }
      saveMatch(this.rec);
    })();
    return { results: res, settled };
  }
}

/** Default AI opponents for a solo shift, by count. */
export const soloBots = (n: number): AgentDef[] => CHEF_AGENTS.slice(0, Math.max(1, Math.min(3, n)));
