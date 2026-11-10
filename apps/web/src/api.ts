// Server API. The wallet session is Better Auth's HttpOnly cookie, sent automatically (same origin).

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const res = await fetch(`/api${path}`, body === undefined ? { headers, credentials: 'same-origin' } : { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface ServerConfig {
  network: string; contract: string; referee: string; chain: boolean;
  agents: { label: string; name: string; account: string; chef: string | null; skill: string | null }[];
}

export interface Me {
  accountId: string;
  chef: string | null;
  token: { metadata: { title: string; media: string; description: string; extra: string } } | null;
  raw: { purse: number; kind: { Chef?: { name: string; inventory: number[]; approved_fee: number; stats: Record<string, number> } } } | null;
  /** energy, upgrades and next prices, from the contract's get_chef */
  econ: ChefEcon | null;
}

export interface GearPrice { level: number; price: string; chef_level: number }
export interface ChefEcon {
  chef: string; level: number; energy: number; energy_max: number; energy_per_shift: number; next_energy_secs: number;
  gear: number[]; next_gear: (GearPrice | null)[]; can_play: boolean;
}
/** The contract's price list (yoctoNEAR strings) and treasury. */
export interface Economy {
  energy_max: number; energy_per_shift: number; energy_regen_secs: number; energy_pack: number; energy_pack_price: string;
  gear: string[]; gear_max: number; gear_prices: string[]; gear_chef_level: number[]; ranked_gear_cap: number; treasury: string;
}

/** yoctoNEAR (string) as a short NEAR amount, e.g. "0.05". */
export const nearAmount = (yocto: string): string => {
  const milli = Number(BigInt(yocto) / 10n ** 21n);
  return String(milli / 1000);
};

export const explorer = (tx: string): string => `https://testnet.nearblocks.io/txns/${tx}`;
export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
