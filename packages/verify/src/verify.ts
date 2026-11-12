// Independent check of a finished match. Needs no keys and trusts nothing the game server says:
// it re-runs the shift from the public input log and compares everything with what the contract holds.
//
//   pnpm verify <matchId> [--host https://…] [--rpc https://…] [--contract sushi-sabotage.testnet]
//
// --rpc puts your endpoint first (repeat it or comma-separate several); the public testnet RPCs in
// rpc.ts follow as fallbacks, and a rate-limited endpoint (429) is skipped and retried after a pause.
import { RpcError, rpcList, viewCall } from './rpc.ts';
import { gearToArray, replay, results, rulesOf, sealOf, sha256Hex, stateHash, type Accusation, type LogEntry, type Setup } from '@sushi/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const id = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const HOST = opt('host', 'https://sushi.lopeselio.online');
const RPCS = rpcList(args.flatMap((a, i) => (a === '--rpc' && args[i + 1] ? [args[i + 1]] : [])));
const CONTRACT = opt('contract', 'sushi-sabotage.testnet');
if (!id) { console.error('usage: pnpm verify <matchId> [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }

interface Bundle {
  id: string; setup: Setup; seed?: string; seedHash: string; log: LogEntry[]; seals: string[];
  openings: { caster: number; target: number; card: string; tick: number; salt: string }[];
  accusations: Accusation[]; results?: { final: number }[]; stateHash?: string; settled: boolean;
  lines: { who: string; text: string; signature?: string; signingAddress?: string }[];
}
interface ChainMatch { seed_hash: string; seals: string[]; settled: boolean; finals: number[]; ranks: number[]; payouts: number[]; royalties: number; ranked: boolean }

const view = <T>(method: string, a: object): Promise<T> => viewCall<T>(RPCS, CONTRACT, method, a, 3, (m) => console.error(m));

/** The proof bundle from the game server, with a readable error when it isn't there. */
async function fetchBundle(): Promise<Bundle> {
  const url = `${HOST}/api/match/${id}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json().catch(() => null)) as (Bundle & { error?: string }) | null;
      // a bundle carries its own `error` (a chain call that failed for that match); a missing match has no id
      if (res.status === 404 || (j && !j.id)) fail(`${url}: ${j?.error ?? 'not found'}. Pick a match id from ${HOST}/api/matches (or the README's example).`);
      if (!res.ok || !j) throw new Error(`HTTP ${res.status}`);
      if (j.error) console.log(`note: the game server recorded a chain error for this match: ${j.error.slice(0, 160)}\n`);
      return j;
    } catch (e) {
      if (attempt >= 2) fail(`couldn't fetch the proof bundle from ${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
function fail(msg: string): never { console.error(`✗ ${msg}`); process.exit(2); }

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};

const bundle = await fetchBundle();
const chain = await view<ChainMatch | null>('get_match', { match_id: id }).catch((e: Error) => fail(e instanceof RpcError ? e.message : `RPC: ${e.message}`));
console.log(`match ${id} — ${bundle.setup.chefs.map((c) => c.name).join(', ')}\n`);

check(!!chain, 'the contract has this match');
if (!chain) process.exit(1);
check(chain.settled, 'the contract settled it');
check(!!bundle.seed && sha256Hex(bundle.seed) === chain.seed_hash, 'seed matches the hash committed at create_match', chain.seed_hash.slice(0, 16));
check(bundle.setup.seed === bundle.seed, 'the sim setup uses that seed');
// the seed names the rules version and AI difficulty ("v2.normal.<hex>"; untagged = v1), so they're committed too
let rv: number | null = null;
try { rv = rulesOf(bundle.setup); } catch (e) { check(false, 'rules version and difficulty match what the seed committed to', (e as Error).message); }
if (rv !== null) check(true, 'rules version and difficulty match what the seed committed to', `rules v${rv}${bundle.setup.difficulty ? `, AI chefs ${bundle.setup.difficulty}` : ''}`);
if (rv === null) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
if (rv >= 3) {
  // rules v3: each chef's upgrades, as the contract checked them against the NFT and recorded them
  const recorded = await view<number[][] | null>('get_match_gear', { match_id: id }).catch((e: Error) => fail(e.message));
  const played = bundle.setup.chefs.map((c) => gearToArray(c.gear));
  const none = played.every((g) => g.every((l) => l === 0));
  const same = recorded ? JSON.stringify(recorded) === JSON.stringify(played) : none;
  check(same, 'chef upgrades in the setup are the ones the contract recorded at create_match', none ? 'none' : played.map((g) => `[${g.join(',')}]`).join(' '));
}
check(JSON.stringify(bundle.seals) === JSON.stringify(chain.seals), `the ${chain.seals.length} seals in the bundle are the ones posted onchain`);
const openOk = bundle.openings.every((o, k) => sealOf({ match: id, ...o }) === chain.seals[k]);
check(openOk && bundle.openings.length === chain.seals.length, 'every opening hashes to its seal');

// re-run the whole shift
const s = replay(bundle.setup, bundle.log);
check(stateHash(s) === bundle.stateHash, 'replaying the input log reaches the recorded end state', stateHash(s).slice(0, 16));
const sabOk = s.sab.length === bundle.openings.length && s.sab.every((x, k) => {
  const o = bundle.openings[k];
  return x.caster === o.caster && x.target === o.target && x.card === o.card && x.tick === o.tick;
});
check(sabOk, `the replay casts exactly the ${s.sab.length} sealed sabotages, in order`);
const finals = results(s, bundle.accusations).map((r) => r.final);
check(JSON.stringify(finals) === JSON.stringify(chain.finals), 'final scores from the replay match the contract', `[${finals.join(', ')}]`);
const pot = chain.payouts.reduce((a, b) => a + b, 0) + chain.royalties;
console.log(`\n${chain.ranked ? `ranked: pot paid out ${pot} ryo (prizes ${chain.payouts.join('/')}, scroll royalties ${chain.royalties})` : 'unranked: no entry fees'}`);
const signed = bundle.lines.filter((l) => l.signature);
console.log(`${bundle.lines.length} AI line(s), ${signed.length} signed by the NEAR AI enclave${signed[0] ? ` (signer ${signed[0].signingAddress})` : ''}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
