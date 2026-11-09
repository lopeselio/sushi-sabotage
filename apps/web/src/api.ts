// Server API. A wallet session token (from NEP-413 sign-in) is kept in localStorage.

const KEY = 'sushi.session';
export const session = {
  get token(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(token: string | null): void { try { if (token) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
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
}

export const explorer = (tx: string): string => `https://testnet.nearblocks.io/txns/${tx}`;
export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
