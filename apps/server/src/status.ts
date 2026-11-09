import { ALL_AGENTS, accountOf } from './agents.ts';
import { config } from './config.ts';

// Operational health: the referee's balance, and each agent's balance and remaining key allowance.
// An agent key's allowance can't be topped up (only its account balance can), so low allowance
// means minting a new agent generation; low balance means scripts/top-up.mjs.

export const LOW_BALANCE = 0.15; // NEAR
export const LOW_ALLOWANCE = 0.05; // NEAR
const YOCTO = 10n ** 24n;
const near = (yocto: string | bigint): number => Number((BigInt(yocto) * 10_000n) / YOCTO) / 10_000;

async function rpc<T>(method: string, params: object): Promise<T> {
  for (const url of [config.rpcUrl, 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000) });
      const j = (await r.json()) as { result?: T };
      if (j.result) return j.result;
    } catch { /* next RPC */ }
  }
  throw new Error(`${method}: no RPC answered`);
}

export interface AccountStatus { account: string; balance: number | null; allowance: number | null; low: boolean }

async function accountStatus(account: string, agent: boolean): Promise<AccountStatus> {
  try {
    const a = await rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: account });
    let allowance: number | null = null;
    if (agent) {
      const keys = await rpc<{ keys: { access_key: { permission: { FunctionCall?: { allowance: string | null } } | string } }[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
      const fc = keys.keys.map((k) => (typeof k.access_key.permission === 'object' ? k.access_key.permission.FunctionCall : undefined)).find(Boolean);
      allowance = fc?.allowance ? near(fc.allowance) : null;
    }
    const balance = near(a.amount);
    return { account, balance, allowance, low: balance < LOW_BALANCE || (allowance !== null && allowance < LOW_ALLOWANCE) };
  } catch {
    return { account, balance: null, allowance: null, low: true };
  }
}

let cache: { at: number; value: AccountStatus[] } | null = null;

export async function chainStatus(): Promise<AccountStatus[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = await Promise.all([accountStatus(config.referee, false), ...ALL_AGENTS.map((a) => accountStatus(accountOf(a), true))]);
  cache = { at: Date.now(), value };
  for (const s of value) if (s.low) console.warn(`LOW: ${s.account} balance ${s.balance} allowance ${s.allowance}`);
  return value;
}
