// End-to-end check of everything a signed-in player does, against the live testnet contract and a
// running server. Creates a fresh faucet-funded test account each run (no real wallet involved).
//   pnpm --filter @sushi/server e2e         (server at http://localhost:8787, or E2E_URL)
// Steps: mint chef -> NEP-413 sign-in -> claim daily -> approve ranked fee -> haggle with the Fixer
// -> accept the offer -> NEP-245 balance -> ranked solo shift with a card loadout -> settlement
// (pot, prizes, royalties) -> leaderboard -> NEP-245 transfer of a card to an AI chef.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { nep413Hash } from './auth.ts';

const URL_ = process.env.E2E_URL ?? 'http://localhost:8787';
const CONTRACT = process.env.CONTRACT_ID ?? 'sushi-sabotage.testnet';
const id = `sushi-e2e-${Date.now().toString(36)}.testnet`;
const step = (s: string): void => console.log(`\n▶ ${s}`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);

step(`create ${id} from the testnet faucet`);
execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
const key = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${id}.json`), 'utf8')).private_key as KeyPairString;
const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
const me = new Account(id, provider, KeyPairSigner.fromSecretKey(key));
await new Promise((r) => setTimeout(r, 3000));
ok('account funded');

async function call<T>(method: string, args: object, yocto = 0n): Promise<T> {
  const out = (await me.signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall(method, args as Record<string, unknown>, teraToGas(100), yocto)], waitUntil: 'EXECUTED_OPTIMISTIC', throwOnFailure: false })) as unknown as { status: { SuccessValue?: string; Failure?: unknown } };
  if (out.status.Failure) throw new Error(`${method}: ${JSON.stringify(out.status.Failure).slice(0, 300)}`);
  const raw = out.status.SuccessValue ? Buffer.from(out.status.SuccessValue, 'base64').toString() : '';
  return (raw ? JSON.parse(raw) : undefined) as T;
}
const view = async <T>(method: string, args: object): Promise<T> => (await provider.callFunction({ contractId: CONTRACT, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${URL_}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}

step('mint a chef (the same call the wallet’s game key makes)');
const chef = await call<string>('mint_chef', { name: 'E2E Chef' });
ok(`minted ${chef}`);

step('sign in to the game server with a NEP-413 signed message');
const ch = await api<{ message: string; nonce: string; recipient: string }>('/auth/challenge');
const kp = KeyPair.fromString(key);
const sig = kp.sign(nep413Hash(ch.message, Buffer.from(ch.nonce, 'base64'), ch.recipient));
const { token } = await api<{ token: string }>('/auth/verify', { accountId: id, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('base64'), nonce: ch.nonce, message: ch.message });
const profile = await api<{ chef: string; raw: { purse: number } }>('/me', undefined, token);
ok(`server sees ${profile.chef} with ${profile.raw.purse} ryo`);

step('claim the daily faucet and enable ranked play');
ok(`purse now ${await call<number>('claim_daily', { chef })}`);
await call('approve_referee', { chef, max_fee: 10 });
ok('entry fees up to 10 ryo approved');

step('haggle with the Fixer, then accept the onchain offer');
const first = await api<{ outcome: { kind: string; price: number }; line: { text: string } }>('/market/haggle', { card: 'soy_slick', offer: 5, round: 0, said: 'Five ryo, final offer.' }, token);
ok(`Fixer: "${first.line.text}" (${first.outcome.kind} ${first.outcome.price})`);
const deal = await api<{ outcome: { kind: string; price: number }; offer: { offerId: number } | null }>('/market/haggle', { card: 'soy_slick', offer: first.outcome.price, round: 1, said: 'Deal.' }, token);
if (!deal.offer) throw new Error(`no deal: ${deal.outcome.kind}`);
await call('accept_offer', { offer_id: deal.offer.offerId });
ok(`bought Soy Slick for ${deal.outcome.price} ryo`);
ok(`NEP-245 mt_balance_of soy_slick = ${(await view<string>('mt_balance_of', { account_id: id, token_id: 'soy_slick' }))}`);

step('play a ranked solo shift bringing the card');
const start = await api<{ matchId: string; ranked: boolean; fee: number; setup: { chefs: { name: string; loadout: object }[] } }>('/solo/start', { name: 'E2E Chef', bots: 2, loadout: [0, 0, 0, 1, 0, 0] }, token);
ok(`match ${start.matchId}: ranked=${start.ranked}, fee ${start.fee}, loadout ${JSON.stringify(start.setup.chefs[0].loadout)}`);
const done = await api<{ results: { name: string; final: number; rank: number }[] }>('/solo/finish', { matchId: start.matchId, log: [{ t: 300, c: 0, i: { card: 'soy_slick', target: 1 } }], accusations: [] }, token);
ok(`results: ${done.results.map((r) => `${r.name} ${r.final}`).join(', ')}`);
let m: { settled: boolean; pot: number; payouts: number[]; royalties: number } | null = null;
for (let k = 0; k < 30 && !m?.settled; k++) { await new Promise((r) => setTimeout(r, 2000)); m = await view('get_match', { match_id: start.matchId }); }
if (!m?.settled) throw new Error('match did not settle');
ok(`settled onchain: prizes ${m.payouts.join('/')} + scroll royalties ${m.royalties}`);
const board = await view<{ chef: string; best: number }[]>('leaderboard', { limit: 100 });
ok(`on the season leaderboard: ${board.some((r) => r.chef === chef)}`);

step('NEP-245: send a card to an AI chef’s account');
const fixerOffer = await api<{ offer: { offerId: number } | null; outcome: { price: number } }>('/market/haggle', { card: 'dull_knife', offer: 999, round: 0 }, token);
await call('accept_offer', { offer_id: fixerOffer.offer!.offerId });
await call('mt_transfer', { receiver_id: `kenji.${CONTRACT}`, token_id: 'dull_knife', amount: '1' }, 1n);
ok(`kenji now holds ${(await view<string>('mt_balance_of', { account_id: `kenji.${CONTRACT}`, token_id: 'dull_knife' }))} dull_knife`);
const tok = await view<{ metadata: { title: string } }>('nft_token', { token_id: chef });
ok(`chef NFT now reads: ${tok.metadata.title}`);
console.log('\nall player steps passed');
