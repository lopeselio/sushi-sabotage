import { ALL_AGENTS, accountOf } from './agents.ts';
import { config } from './config.ts';
import { addSample, freeNear, runway, type Runway, type StorageSample } from './runway.ts';
import { kvGet, kvSet } from './store.ts';

// Operational health: the referee's balance, and each agent's balance and remaining key allowance.
// An agent key's allowance can't be topped up (only its account balance can), so low allowance
// means minting a new agent generation; low balance means scripts/top-up.mjs.

export const LOW_BALANCE = 0.15; // NEAR
export const LOW_ALLOWANCE = 0.05; // NEAR
const YOCTO = 10n ** 24n;
const near = (yocto: string | bigint): number => Number((BigInt(yocto) * 10_000n) / YOCTO) / 10_000;

async function rpc<T>(method: string, params: object): Promise<T> {
  for (const url of [config.rpcUrl, 'https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org'].filter((u, i, a) => a.indexOf(u) === i)) {
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

/** The demo stays up for judging until this date; the contract's storage NEAR must last that long. */
export const HOSTED_UNTIL = Date.parse(process.env.HOSTED_UNTIL ?? '2026-11-25T23:59:59Z');

/**
 * The contract's free NEAR (balance not locked for storage), how fast its storage grows and when it
 * runs out. Samples of storage_usage persist in kv.json, so the growth rate survives restarts.
 */
export async function contractStatus(now = Date.now()): Promise<(Runway & { account: string }) | { account: string; free: null; warning: string }> {
  const account = config.contract;
  try {
    const a = await rpc<{ amount: string; locked: string; storage_usage: number }>('query', { request_type: 'view_account', finality: 'final', account_id: account });
    const samples = addSample(kvGet<StorageSample[]>('storageSamples', []), { at: now, bytes: a.storage_usage });
    kvSet('storageSamples', samples);
    return { account, ...runway(freeNear(a.amount, a.storage_usage, a.locked), a.storage_usage, samples, now, HOSTED_UNTIL, account) };
  } catch {
    return { account, free: null, warning: `couldn't read ${account} from any RPC` };
  }
}

export interface ChainStatus { accounts: AccountStatus[]; contract: Awaited<ReturnType<typeof contractStatus>>; warnings: string[] }

let cache: { at: number; value: ChainStatus } | null = null;

export async function chainStatus(): Promise<ChainStatus> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const [accounts, contract] = await Promise.all([
    Promise.all([accountStatus(config.referee, false), ...ALL_AGENTS.map((a) => accountStatus(accountOf(a), true))]),
    contractStatus(),
  ]);
  const warnings = [
    ...(contract.warning ? [contract.warning] : []),
    ...accounts.filter((s) => s.low).map((s) => `${s.account}: balance ${s.balance} NEAR, key allowance ${s.allowance ?? 'n/a'} (top up with scripts/top-up.mjs)`),
  ];
  const value = { accounts, contract, warnings };
  cache = { at: Date.now(), value };
  for (const w of warnings) console.warn(`ALERT: ${w}`);
  return value;
}

/** Checks every 10 minutes, so the storage samples and the log alerts keep coming with nobody looking. */
export function startWatch(): void {
  const tick = (): void => { void chainStatus().catch((e) => console.warn('status:', (e as Error).message)); };
  setTimeout(tick, 15_000);
  setInterval(tick, 10 * 60_000).unref();
}
