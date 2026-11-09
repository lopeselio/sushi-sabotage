// One-time setup of the agents on testnet. Idempotent: re-running skips what exists.
//   pnpm --filter @sushi/server setup:agents
// For each agent: a sub-account of the contract whose ONLY key is a function-call key for the
// agent methods (created by the contract), a registered chef with spending caps, and fee approval.
// Then the 20 Recipe Scrolls: four to each AI chef (so agents earn royalties too), four kept for prizes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { ALL_AGENTS, CHEF_AGENTS, DAY_CAP, MATCH_CAP, accountOf } from './agents.ts';
import { call, provider, view } from './chain.ts';
import { config } from './config.ts';

const OWNER = config.contract;
const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });

async function exists(id: string): Promise<boolean> {
  try { await provider.viewAccount({ accountId: id, finalityQuery: { finality: 'final' } } as never); return true; } catch { return false; }
}

for (const a of ALL_AGENTS) {
  const acct = accountOf(a);
  const file = join(credDir, `${acct}.json`);
  if (!(await exists(acct))) {
    if (existsSync(file)) throw new Error(`${file} exists but ${acct} doesn't; move the old key away first`);
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(file, JSON.stringify({ account_id: acct, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await call(OWNER, 'create_agent_account', { name: a.label, public_key: kp.getPublicKey().toString() }, 100, 500_000_000_000_000_000_000_000n);
    console.log(`created ${acct} (function-call key only) ${r.tx}`);
    await new Promise((r) => setTimeout(r, 2500));
  } else console.log(`${acct} exists`);

  let chef = await view<string | null>('chef_of', { account_id: acct });
  if (!chef || !(await view('get_agent', { account_id: acct }))) {
    const r = await call<string>(OWNER, 'register_agent', { account: acct, name: a.name, day_cap: DAY_CAP, match_cap: MATCH_CAP });
    chef = r.value;
    console.log(`registered ${a.name} as ${chef} (caps ${DAY_CAP}/day, ${MATCH_CAP}/match) ${r.tx}`);
  }
  if (a.skill) {
    const r = await call(acct, 'approve_referee', { chef, max_fee: MATCH_CAP });
    console.log(`${a.name} approved entry fees up to ${MATCH_CAP} ${r.tx}`);
  }
}

for (let recipe = 0; recipe < 20; recipe++) {
  const owner = recipe < 16 ? accountOf(CHEF_AGENTS[Math.floor(recipe / 4)]) : OWNER;
  const t = await view('get_token', { token_id: `scroll-${recipe}` });
  if (t) continue;
  const r = await call(OWNER, 'mint_scroll', { recipe, to: owner });
  console.log(`scroll-${recipe} -> ${owner} ${r.tx}`);
}
console.log('done');
