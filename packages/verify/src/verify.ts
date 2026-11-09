// Independent check of a finished match. Needs no keys and trusts nothing the game server says:
// it re-runs the shift from the public input log and compares everything with what the contract holds.
//
//   pnpm verify <matchId> [--host https://…] [--rpc https://…] [--contract sushi-sabotage.testnet]
import { replay, results, sealOf, sha256Hex, stateHash, type Accusation, type LogEntry, type Setup } from '@sushi/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const id = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const HOST = opt('host', 'https://sushi-sabotage.happyflower-1d86c59e.northeurope.azurecontainerapps.io');
const RPC = opt('rpc', 'https://rpc.testnet.near.org');
const CONTRACT = opt('contract', 'sushi-sabotage.testnet');
if (!id) { console.error('usage: pnpm verify <matchId> [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }

interface Bundle {
  id: string; setup: Setup; seed?: string; seedHash: string; log: LogEntry[]; seals: string[];
  openings: { caster: number; target: number; card: string; tick: number; salt: string }[];
  accusations: Accusation[]; results?: { final: number }[]; stateHash?: string; settled: boolean;
  lines: { who: string; text: string; signature?: string; signingAddress?: string }[];
}
interface ChainMatch { seed_hash: string; seals: string[]; settled: boolean; finals: number[]; ranks: number[]; payouts: number[]; royalties: number; ranked: boolean }

async function view<T>(method: string, a: object): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') } }),
  });
  const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) throw new Error(`RPC: ${JSON.stringify(j.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
}

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};

const bundle = (await (await fetch(`${HOST}/api/match/${id}`)).json()) as Bundle & { error?: string };
if (bundle.error) { console.error(bundle.error); process.exit(2); }
const chain = await view<ChainMatch | null>('get_match', { match_id: id });
console.log(`match ${id} — ${bundle.setup.chefs.map((c) => c.name).join(', ')}\n`);

check(!!chain, 'the contract has this match');
if (!chain) process.exit(1);
check(chain.settled, 'the contract settled it');
check(!!bundle.seed && sha256Hex(bundle.seed) === chain.seed_hash, 'seed matches the hash committed at create_match', chain.seed_hash.slice(0, 16));
check(bundle.setup.seed === bundle.seed, 'the sim setup uses that seed');
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
