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
}

export const explorer = (tx: string): string => `https://testnet.nearblocks.io/txns/${tx}`;
export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
