#!/usr/bin/env node
// Tops up the referee and agent accounts from the contract owner account when they run low.
//   node scripts/top-up.mjs [--dry-run]
// Uses near CLI (near-cli-rs) and the owner's key in ~/.near-credentials. Reads balances from /api/status
// of a running server (STATUS_URL, default the hosted demo) so it uses the same thresholds.
import { execFileSync } from 'node:child_process';

const STATUS_URL = process.env.STATUS_URL ?? 'https://sushi-sabotage.happyflower-1d86c59e.northeurope.azurecontainerapps.io/api/status';
const OWNER = process.env.OWNER_ID ?? 'sushi-sabotage.testnet';
const TARGET = { referee: 3, agent: 0.5 }; // NEAR to top each up to
const dry = process.argv.includes('--dry-run');

const status = await (await fetch(STATUS_URL)).json();
for (const a of status.accounts) {
  const isAgent = a.allowance !== null;
  const want = isAgent ? TARGET.agent : TARGET.referee;
  if (a.balance === null || a.balance >= want * 0.6) { console.log(`ok   ${a.account} ${a.balance} NEAR`); continue; }
  const amount = (want - a.balance).toFixed(3);
  console.log(`${dry ? 'would send' : 'send'} ${amount} NEAR -> ${a.account} (has ${a.balance})`);
  if (isAgent && a.allowance !== null && a.allowance < 0.05) console.log(`  note: ${a.account}'s key allowance is ${a.allowance} NEAR; that can't be topped up — create a new agent generation`);
  if (!dry) execFileSync('near', ['tokens', OWNER, 'send-near', a.account, `${amount} NEAR`, 'network-config', 'testnet', 'sign-with-legacy-keychain', 'send'], { stdio: 'inherit' });
}
