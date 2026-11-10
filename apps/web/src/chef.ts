import './chef.css';
import { CARD_INFO, CARDS, GEAR, GEAR_INFO, RANKED_GEAR_CAP, type GearSlot } from '@sushi/rules';
import { api, explorerAccount, nearAmount, type ChefEcon, type Economy, type Me } from './api.ts';
import { h, toast } from './ui.ts';
import { call, pay } from './wallet.ts';

// The Chef NFT on screen: the free mint, the chef card (level, stats, energy, upgrades), NEAR
// purchases, and the invitation a guest gets after a shift. Self-contained; main.ts places it.
//
// Free things (mint, faucet, ranked approval) are gasless meta-transactions through the game's
// relayer. Purchases attach NEAR, which the relayer never does, so they're ordinary wallet
// transactions and the UI says so before the wallet opens.

export interface ChefHooks {
  /** the current signed-in profile (null for a guest) */
  me: () => Me | null;
  /** reload /api/me after a transaction and re-render whatever is showing */
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  /** the name the player typed on the title screen */
  defaultName: () => string;
}

let economy: Economy | null = null;
export async function loadEconomy(): Promise<Economy | null> {
  economy ??= await api<Economy | null>('/economy').catch(() => null);
  return economy;
}

const GEAR_ICON: Record<GearSlot, string> = { knife: '🔪', pan: '🍳', sandals: '🩴', apron: '🥋' };
const cleanName = (s: string): string => s.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20) || 'Chef';

function energyBar(e: ChefEcon, big = false): HTMLElement {
  const pct = Math.round((100 * e.energy) / e.energy_max);
  const low = e.energy < e.energy_per_shift;
  const shifts = Math.floor(e.energy / e.energy_per_shift);
  const regen = e.energy >= e.energy_max ? 'full' : `+1 in ${e.next_energy_secs}s · 100 an hour`;
  return h('div', { class: `energy${low ? ' low' : ''}${big ? ' big' : ''}`, title: `${e.energy}/${e.energy_max} energy. A recorded shift costs ${e.energy_per_shift}.` },
    h('div', { class: 'energy-head' }, h('span', {}, '⚡ Energy'), h('b', {}, `${e.energy}/${e.energy_max}`)),
    h('div', { class: 'energy-track' }, h('div', { class: 'energy-fill', style: `width:${pct}%` })),
    h('small', { class: 'dim' }, low ? `Out of energy: shifts play as a guest (not recorded) until it refills. ${regen}` : `${shifts} recorded shift${shifts === 1 ? '' : 's'} left · ${regen}`));
}

/** The big free-mint call to action (signed in, no chef yet). */
export function mintCta(hooks: ChefHooks, compact = false): HTMLElement {
  const name = h('input', { value: cleanName(hooks.defaultName()), maxlength: 20, 'aria-label': 'Chef name' });
  const btn = h('button', { class: 'big mint', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Minting… approve it in your wallet';
    try {
      const r = await call('mint_chef', { name: cleanName(name.value) });
      await hooks.refresh();
      toast(`Your chef is minted${r.gasless ? ' (gas paid by the game)' : ''}!`, 'good');
    } catch (e) { toast((e as Error).message, 'bad'); btn.disabled = false; btn.textContent = 'Mint your chef — free'; }
  } }, 'Mint your chef — free');
  return h('div', { class: `mint-cta${compact ? ' compact' : ''}` },
    h('div', { class: 'mint-art', 'aria-hidden': 'true' }, '👨‍🍳'),
    h('div', {},
      h('h3', {}, 'Mint your chef — free'),
      h('p', { class: 'dim' }, 'One Chef NFT per account. No deposit, no gas: you approve it once in your wallet and the game pays. It starts with 100 ryo and full energy, and from then on your shifts count: XP, levels, upgrades, the leaderboard.'),
      h('div', { class: 'row' }, name, btn)));
}

/** For a guest: sign in first. */
export function signInCta(hooks: ChefHooks, after = false): HTMLElement {
  return h('div', { class: 'mint-cta invite' },
    h('div', { class: 'mint-art', 'aria-hidden': 'true' }, '🏮'),
    h('div', {},
      h('h3', {}, after ? 'Make your next shift count' : 'Get a free Chef NFT'),
      h('p', { class: 'dim' }, after
        ? 'That shift was a guest shift, so nothing was recorded. Sign in with a NEAR testnet wallet and mint your chef for free: from your next shift on you earn XP and levels, unlock upgrades and climb the leaderboard.'
        : 'Guests play free. Sign in with a NEAR testnet wallet to mint a Chef NFT for free (the game pays the gas) and have your shifts recorded.'),
      h('div', { class: 'row' }, h('button', { class: 'big mint', onclick: () => void hooks.signIn() }, 'Sign in with NEAR'), after ? h('small', { class: 'dim' }, 'then press “Mint your chef — free”') : null)));
}

/** A small chip for the title screen: the chef's name, level and energy, or the mint/sign-in call to action. */
export function chefSlot(hooks: ChefHooks, open: () => void): HTMLElement {
  const me = hooks.me();
  if (!me) return signInCta(hooks);
  if (!me.chef) return mintCta(hooks, true);
  const e = me.econ;
  const name = me.raw?.kind.Chef?.name ?? me.chef;
  return h('button', { class: 'chef-chip', onclick: open, title: 'Open your chef card' },
    h('span', { class: 'chip-face', 'aria-hidden': 'true' }, '👨‍🍳'),
    h('span', { class: 'chip-main' }, h('b', {}, name), h('small', { class: 'dim' }, `Lv ${e?.level ?? 1} · ${me.raw?.purse ?? 0} ryo`)),
    e ? energyBar(e) : null);
}

/** After a shift: the guest's invitation, the signed-in-without-chef mint, or the chef's energy. */
export function resultsCta(hooks: ChefHooks, recorded: boolean, noEnergy = false): HTMLElement | null {
  const me = hooks.me();
  if (!me) return signInCta(hooks, true);
  if (!me.chef) return mintCta(hooks);
  if (noEnergy) return h('div', { class: 'mint-cta invite' }, h('div', { class: 'mint-art' }, '⚡'), h('div', {}, h('h3', {}, 'Out of energy: this shift was not recorded'), h('p', { class: 'dim' }, 'Energy comes back by itself (100 an hour), or buy a pack on your chef card.')));
  return recorded && me.econ ? h('div', { class: 'after-shift' }, energyBar(me.econ)) : null;
}

async function confirmPay(what: string, yocto: string, method: string, args: object, hooks: ChefHooks): Promise<void> {
  const ok = window.confirm(`${what}\n\nYou pay ${nearAmount(yocto)} testnet NEAR from your wallet. This is an ordinary wallet transaction (the game's free gas relayer never carries payments), so your wallet will show the amount and a small gas fee.\n\nThe NEAR goes to the game contract's treasury.`);
  if (!ok) return;
  try {
    const r = await pay(method, args, yocto);
    toast(`${what}: done`, 'good');
    if (r.tx) toast(`Tx ${r.tx.slice(0, 10)}… on testnet.nearblocks.io`, 'info');
    await hooks.refresh();
  } catch (e) { toast((e as Error).message, 'bad'); }
}

function upgradeTile(slot: GearSlot, k: number, e: ChefEcon, chef: string, hooks: ChefHooks): HTMLElement {
  const lvl = e.gear[k] ?? 0;
  const next = e.next_gear[k];
  const info = GEAR_INFO[slot];
  const locked = next && e.level < next.chef_level;
  return h('div', { class: `gear${lvl ? ' owned' : ''}` },
    h('div', { class: 'gear-head' }, h('span', { class: 'gear-icon', 'aria-hidden': 'true' }, GEAR_ICON[slot]), h('b', {}, info.name), h('span', { class: 'pips', 'aria-label': `level ${lvl} of 5` }, ...[1, 2, 3, 4, 5].map((n) => h('i', { class: n <= lvl ? 'on' : n <= RANKED_GEAR_CAP ? '' : 'over' })))),
    h('small', { class: 'dim' }, info.blurb),
    h('small', {}, lvl ? `Now: ${info.per(lvl)}${lvl > RANKED_GEAR_CAP ? ` (ranked: ${info.per(RANKED_GEAR_CAP)})` : ''}` : 'Not upgraded'),
    next
      ? h('button', {
        class: 'buy', disabled: !!locked,
        title: locked ? `Level ${next.level} needs a level ${next.chef_level} chef` : `Level ${next.level}: ${info.per(next.level)}`,
        onclick: () => void confirmPay(`${info.name} level ${next.level} for ${e.chef}`, next.price, 'buy_upgrade', { chef, slot }, hooks),
      }, locked ? `🔒 Lv ${next.level} needs chef Lv ${next.chef_level}` : `Lv ${next.level} · ${nearAmount(next.price)} NEAR`)
      : h('span', { class: 'maxed' }, 'Max level'));
}

/** The full chef card: the NFT image, level, stats, energy, upgrades, cards and the free actions. */
export async function chefCard(hooks: ChefHooks): Promise<HTMLElement> {
  const me = hooks.me();
  if (!me) return h('div', { class: 'panel chefcard' }, h('h2', {}, 'Your Chef NFT'), signInCta(hooks));
  if (!me.chef || !me.token || !me.raw) return h('div', { class: 'panel chefcard' }, h('h2', {}, 'Your Chef NFT'), mintCta(hooks));
  const econ = await loadEconomy();
  const e = me.econ;
  const raw = me.raw;
  const c = raw.kind.Chef!;
  const extra = JSON.parse(me.token.metadata.extra) as { level: number; title: string; stats: Record<string, number> };
  const st = c.stats;
  const xp = st.xp ?? 0;
  // level = 1 + floor(sqrt(xp / 50)): progress to the next one
  const lv = extra.level;
  const from = 50 * (lv - 1) ** 2, to = 50 * lv ** 2;
  const xpPct = Math.max(0, Math.min(100, Math.round((100 * (xp - from)) / (to - from))));
  const free = (label: string, fn: () => Promise<unknown>): HTMLElement => h('button', { class: 'ghost', onclick: async (ev: Event) => {
    const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
    try { await fn(); toast(`${label}: done (gas paid by the game)`, 'good'); await hooks.refresh(); } catch (err) { toast((err as Error).message, 'bad'); b.disabled = false; }
  } }, label);
  const stat = (k: string, label: string): HTMLElement => h('div', { class: 'stat' }, h('b', {}, String(st[k] ?? 0)), h('small', {}, label));
  const packFits = !!e && !!econ && e.energy + econ.energy_pack <= e.energy_max;

  return h('div', { class: 'panel chefcard' },
    h('div', { class: 'cc-left' },
      h('div', { class: 'nft' }, h('img', { src: me.token.metadata.media, alt: me.token.metadata.title })),
      h('p', { class: 'dim small' }, 'This image and its stats are drawn by the contract from the token itself. Transfer the NFT and its purse, cards, energy and upgrades go with it.'),
      h('a', { class: 'dim small', href: explorerAccount(me.accountId), target: '_blank' }, `${me.chef} · owned by ${me.accountId}`)),
    h('div', { class: 'cc-right' },
      h('div', { class: 'cc-title' }, h('h2', {}, c.name), h('span', { class: 'badge' }, `Lv ${lv} · ${extra.title}`)),
      h('div', { class: 'xp', title: `${xp} XP (level ${lv + 1} at ${to})` }, h('div', { class: 'xp-fill', style: `width:${xpPct}%` }), h('small', {}, `${xp} / ${to} XP to level ${lv + 1}`)),
      h('div', { class: 'stats' }, stat('shifts', 'shifts'), stat('delivered', 'served'), stat('wins', 'wins'), stat('best', 'best'), stat('casts', 'sabotages'), stat('sleuth', 'caught a rival'), stat('caught', 'got caught'), stat('burns', 'burnt')),
      e ? energyBar(e, true) : null,
      e && econ ? h('div', { class: 'row pack' },
        h('button', { disabled: !packFits, title: packFits ? '' : `A pack fits when energy is ${e.energy_max - econ.energy_pack} or less`, onclick: () => void confirmPay(`Energy pack (+${econ.energy_pack}) for ${c.name}`, econ.energy_pack_price, 'buy_energy', { chef: me.chef }, hooks) }, `⚡ +${econ.energy_pack} energy · ${nearAmount(econ.energy_pack_price)} NEAR`),
        h('small', { class: 'dim' }, `A recorded shift costs ${e.energy_per_shift}. Energy refills by itself; guests never need any.`)) : null,
      h('h3', {}, 'Upgrades'),
      h('p', { class: 'dim small' }, `Paid in testnet NEAR, one level at a time; higher levels need a higher-level chef. Ranked shifts count up to level ${RANKED_GEAR_CAP} of each, so nobody buys a win.`),
      e ? h('div', { class: 'gears' }, ...GEAR.map((g, k) => upgradeTile(g, k, e, me.chef!, hooks))) : h('p', { class: 'dim' }, 'Upgrades load from the contract…'),
      h('h3', {}, 'Purse and cards'),
      h('p', {}, h('b', {}, `${raw.purse} ryo`), h('span', { class: 'dim' }, ` · ranked entry fee approved: ${c.approved_fee} ryo`)),
      h('div', { class: 'cards-owned' }, ...CARDS.map((card, k) => h('span', { class: `cardchip${c.inventory[k] ? '' : ' none'}` }, `${CARD_INFO[card].name} ×${c.inventory[k] ?? 0}`))),
      h('div', { class: 'row' },
        free('Claim daily 50 ryo', () => call('claim_daily', { chef: me.chef })),
        c.approved_fee >= 10 ? free('Disable ranked', () => call('approve_referee', { chef: me.chef, max_fee: 0 })) : free('Enable ranked (10 ryo/match)', () => call('approve_referee', { chef: me.chef, max_fee: 10 }))),
      h('p', { class: 'dim small' }, 'Free actions are gasless: your wallet signs, the game’s relayer pays.')));
}
