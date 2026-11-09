import { CARD_INFO, CARDS, haggle, listPrice, type BotSkill, type Card, type HaggleOutcome } from '@sushi/rules';
import { call, view } from './chain.ts';
import { config, hasKey } from './config.ts';
import { voice, type SignedLine } from './nearai.ts';
import { kvGet, kvSet } from './store.ts';

// The agents: four AI chefs, the Fixer (sells sabotage cards) and the Scout (sells reports).
// Each is a sub-account of the contract whose only key is a function-call key for a few
// contract methods; the contract caps what each chef agent may spend per day and per match.

export interface AgentDef { label: string; name: string; skill?: BotSkill; persona: string }

export const CHEF_AGENTS: AgentDef[] = [
  { label: 'kenji', name: 'Kenji', skill: 'hard', persona: 'Kenji, a proud, sharp-tongued veteran itamae who thinks everyone else is an amateur' },
  { label: 'mei', name: 'Mei', skill: 'normal', persona: 'Mei, a cheerful, sly street-stall chef who smiles while she sabotages you' },
  { label: 'hana', name: 'Hana', skill: 'normal', persona: 'Hana, a calm, precise chef who speaks in short, cold sentences' },
  { label: 'tomo', name: 'Tomo', skill: 'easy', persona: 'Tomo, a nervous, eager apprentice who apologises a lot and burns rice' },
];
export const FIXER: AgentDef = { label: 'fixer', name: 'The Fixer', persona: 'the Fixer, a smooth night-market dealer in kitchen sabotage who loves a deal but never goes below his floor' };
export const SCOUT: AgentDef = { label: 'scout', name: 'Scout Nori', persona: 'Scout Nori, a gossip who sells what she knows about rival chefs' };
export const ALL_AGENTS = [...CHEF_AGENTS, FIXER, SCOUT];

export const accountOf = (a: AgentDef): string => `${a.label}.${config.contract}`;
export const DAY_CAP = 150;
export const MATCH_CAP = 10;

const chefIds = new Map<string, string>();

/** The agent's chef token id, if it's set up onchain and its key is here. */
export async function agentChef(a: AgentDef): Promise<string | null> {
  const acct = accountOf(a);
  if (chefIds.has(acct)) return chefIds.get(acct)!;
  if (!config.chainEnabled || !hasKey(acct)) return null;
  try {
    const id = await view<string | null>('chef_of', { account_id: acct });
    if (id) chefIds.set(acct, id);
    return id ?? null;
  } catch { return null; }
}

// ---------- receipts feed (what the agents did, for the UI) ----------

export interface AgentAct { at: number; who: string; what: string; tx?: string }
const acts: AgentAct[] = kvGet<AgentAct[]>('acts', []);
export function logAct(who: string, what: string, tx?: string): void {
  acts.unshift({ at: Date.now(), who, what, tx });
  acts.length = Math.min(acts.length, 60);
  kvSet('acts', acts);
}
export const recentActs = (): AgentAct[] => acts;

// ---------- the Fixer's market ----------

const sales = (): Record<string, number[]> => kvGet<Record<string, number[]>>('sales', {});
export function prices(now = Date.now()): Record<Card, number> {
  const s = sales();
  return Object.fromEntries(CARDS.map((c) => [c, listPrice(c, s[c] ?? [], now)])) as Record<Card, number>;
}
function recordSale(card: Card): void {
  const s = sales();
  const now = Date.now();
  s[card] = [...(s[card] ?? []).filter((t) => now - t < 3600_000), now];
  kvSet('sales', s);
}

/** The Fixer posts an offer for `buyerChef` onchain; the buyer accepts it with their own key. */
export async function fixerOffer(buyerChef: string, card: Card, price: number): Promise<{ offerId: number; tx: string }> {
  const fixerChef = await agentChef(FIXER);
  if (!fixerChef) throw new Error('the Fixer is not set up on this server');
  const r = await call<number>(accountOf(FIXER), 'post_offer', { seller_chef: fixerChef, buyer_chef: buyerChef, card, price, ttl_secs: 600 });
  recordSale(card);
  logAct(FIXER.name, `offered ${CARD_INFO[card].name} to ${buyerChef} for ${price} ryo`, r.tx);
  return { offerId: r.value, tx: r.tx };
}

export interface HaggleReply { outcome: HaggleOutcome; line: SignedLine; list: number }

/** One haggle round with the Fixer. The rules decide the price; NEAR AI only voices it. */
export async function haggleWithFixer(card: Card, offer: number, round: 0 | 1, said: string): Promise<HaggleReply> {
  const list = prices()[card];
  const outcome = haggle(list, offer, round);
  const fallback = {
    accept: `${outcome.price} ryo. Pleasure doing business.`,
    counter: `${offer}? Cute. ${outcome.price} and it's yours.`,
    refuse: `No. ${list} ryo, take it or leave it.`,
  }[outcome.kind];
  const line = await voice(
    FIXER.name,
    `You are ${FIXER.persona}. Reply in one or two short sentences, in character. You must state the exact price given and must not change it.`,
    `The buyer wants a "${CARD_INFO[card].name}" card (list ${list} ryo). They said: "${said.slice(0, 200)}". They offered ${offer} ryo. Your decision (fixed, do not change): ${outcome.kind} at ${outcome.price} ryo.`,
    fallback,
  );
  return { outcome, line, list };
}

// ---------- the AI chefs' own economy ----------

interface ChefToken { owner_id: string; purse: number; kind: { Chef?: { inventory: number[]; stats: { best: number } } } }

/** One pass of every AI chef: claim the faucet, restock a card from the Fixer, buy a scout report. */
export async function agentEconomyTick(): Promise<void> {
  if (!config.chainEnabled) return;
  const fixerChef = await agentChef(FIXER);
  const scoutChef = await agentChef(SCOUT);
  const board = await view<{ chef: string; name: string; best: number }[]>('leaderboard', { limit: 5 }).catch(() => []);
  for (const a of CHEF_AGENTS) {
    const chef = await agentChef(a);
    if (!chef) continue;
    const acct = accountOf(a);
    const day = Math.floor(Date.now() / 86_400_000);
    try {
      if (kvGet(`claimed:${acct}`, -1) !== day) {
        const r = await call(acct, 'claim_daily', { chef });
        kvSet(`claimed:${acct}`, day);
        logAct(a.name, 'claimed the daily 50 ryo', r.tx);
      }
      const t = await view<ChefToken | null>('get_token', { token_id: chef });
      const inv = t?.kind.Chef?.inventory ?? [];
      const held = inv.reduce((x, y) => x + y, 0);
      if (fixerChef && t && held < 2) {
        // each chef has a favourite card; buy it if the price fits the budget
        const favourite: Card = (['wasabi_bomb', 'fish_swap', 'order_shuffle', 'soy_slick'] as Card[])[CHEF_AGENTS.indexOf(a)];
        const price = prices()[favourite];
        // keep enough of today's budget for three league entries
        const policy = await view<{ day: number; spent_today: number; day_cap: number } | null>('get_agent', { account_id: acct }).catch(() => null);
        const spent = policy && policy.day === day ? policy.spent_today : 0;
        const room = (policy?.day_cap ?? DAY_CAP) - spent - 3 * MATCH_CAP;
        if (t.purse >= price + 3 * MATCH_CAP && price <= 30 && price <= room) {
          const { offerId } = await fixerOffer(chef, favourite, price);
          const r = await call(acct, 'accept_offer', { offer_id: offerId });
          logAct(a.name, `bought ${CARD_INFO[favourite].name} from the Fixer for ${price} ryo`, r.tx);
        }
      }
      // pay for data: a report on the current leader, at most once an hour
      const top = board.find((row) => row.chef !== chef);
      const lastScout = kvGet<number>(`scouted:${acct}`, 0);
      if (scoutChef && top && Date.now() - lastScout > 3600_000 && (t?.purse ?? 0) > 20) {
        const r = await call(acct, 'buy_scout', { buyer_chef: chef, scout_chef: scoutChef, about_chef: top.chef });
        kvSet(`scouted:${acct}`, Date.now());
        kvSet(`rival:${acct}`, top.chef);
        logAct(a.name, `paid Scout Nori 5 ryo for a report on ${top.name}`, r.tx);
      }
    } catch (e) {
      logAct(a.name, `couldn't act: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

/** The chef an AI chef scouted as its rival, if any. */
export const scoutedRival = (a: AgentDef): string | null => kvGet<string | null>(`rival:${accountOf(a)}`, null);

/** Cards an AI chef brings to a match: up to two from its inventory. */
export async function agentLoadout(a: AgentDef): Promise<number[]> {
  const chef = await agentChef(a);
  if (!chef) return [];
  const t = await view<ChefToken | null>('get_token', { token_id: chef }).catch(() => null);
  const inv = t?.kind.Chef?.inventory ?? [];
  let budget = 2;
  return CARDS.map((_, k) => { const n = Math.min(inv[k] ?? 0, budget); budget -= n; return n; });
}

const TAUNTS: Record<string, string[]> = {
  kenji: ['Try to keep up. Or don\'t.', 'Your rice is a crime.'],
  mei: ['Good luck tonight! You\'ll need it~', 'Oops. Was that your pan?'],
  hana: ['Focus.', 'Precision wins.'],
  tomo: ['S-sorry in advance!', 'I\'ll do my best, chef!'],
};

/** A pre-shift taunt from an AI chef, voiced by a TEE model. */
export function taunt(a: AgentDef, rivals: string[]): Promise<SignedLine> {
  const pool = TAUNTS[a.label] ?? ['Let\'s cook.'];
  return voice(
    a.name,
    `You are ${a.persona}, about to start a 3-minute sushi shift against rival chefs at a night market. Say one short taunt (under 15 words). No hashtags, no emojis.`,
    `Your rivals tonight: ${rivals.join(', ')}.`,
    pool[Math.floor(Math.random() * pool.length)],
  );
}
