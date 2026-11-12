// Contract views over public testnet RPCs. Public endpoints rate-limit (HTTP 429, or a JSON-RPC
// error that says so) and some are retired (rpc.testnet.near.org answers -429 "deprecated"), so
// every call walks a list of endpoints, backs off on a rate limit, and ends in a readable error.

export const DEFAULT_RPCS = [
  'https://testnet-rpc.intea.rs',
  'https://near-testnet.drpc.org',
  'https://test.rpc.fastnear.com',
  'https://rpc.testnet.fastnear.com',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RpcError extends Error {}

/** `--rpc URL` (repeatable, or comma-separated) goes first; the defaults follow as fallbacks. */
export function rpcList(given: string[]): string[] {
  const mine = given.flatMap((g) => g.split(',')).map((u) => u.trim()).filter(Boolean);
  return [...mine, ...DEFAULT_RPCS].filter((u, i, a) => a.indexOf(u) === i);
}

const rateLimited = (status: number, body: string): boolean => status === 429 || /429|rate.?limit|too many requests|deprecated/i.test(body);

/**
 * A view call. Tries each endpoint in turn, up to `rounds` passes over the list, waiting longer
 * after each pass when every endpoint was rate-limited. A contract error (the method panicked, the
 * account doesn't exist) is final and is thrown at once.
 */
export async function viewCall<T>(rpcs: string[], contract: string, method: string, args: object, rounds = 3, log: (m: string) => void = () => undefined): Promise<T> {
  const params = { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') };
  const tried: string[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const url of rpcs) {
      let status = 0;
      let text = '';
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }), signal: AbortSignal.timeout(10_000) });
        status = res.status;
        text = await res.text();
      } catch (e) {
        tried.push(`${url}: ${(e as Error).message}`);
        continue;
      }
      let j: { result?: { result?: number[]; error?: string }; error?: { cause?: { name?: string }; message?: string; data?: unknown } } | null = null;
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      if (j?.result?.result) return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
      if (j?.result?.error) throw new RpcError(`${method} on ${contract}: ${j.result.error.slice(0, 200)}`);
      if (rateLimited(status, text)) { tried.push(`${url}: rate-limited`); log(`  (${url} is rate-limiting; trying the next RPC)`); continue; }
      const cause = j?.error?.cause?.name;
      if (cause === 'UNKNOWN_ACCOUNT' || cause === 'CONTRACT_EXECUTION_ERROR') throw new RpcError(`${method} on ${contract}: ${cause} ${JSON.stringify(j?.error?.data ?? '').slice(0, 200)}`);
      tried.push(`${url}: HTTP ${status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    if (round < rounds - 1) await sleep(2000 * (round + 1));
  }
  throw new RpcError(`no RPC answered ${method} (every endpoint failed or rate-limited this IP). Tried:\n  ${tried.slice(-rpcs.length).join('\n  ')}\nWait a minute and run it again, or pass a working endpoint: --rpc https://…`);
}
