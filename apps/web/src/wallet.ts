import type { NearConnector } from '@hot-labs/near-connect';
import { api, session } from './api.ts';

// NEAR wallet sign-in through NEAR Connect. At sign-in the wallet adds a function-call key
// (limited to our contract and a few methods), so later game calls sign silently: no popups, no gas prompts.

export const PLAYER_METHODS = ['mint_chef', 'claim_daily', 'approve_referee', 'accept_offer', 'buy_scout', 'rename_chef', 'move_purse'];
let contract = 'sushi-sabotage.testnet';
let connectorP: Promise<NearConnector> | null = null;

export function setContract(id: string): void { contract = id; }

function connector(): Promise<NearConnector> {
  connectorP ??= (async () => {
    const [{ NearConnector }, { createAccessKeyPlugin }] = await Promise.all([import('@hot-labs/near-connect'), import('function-call-key-plugin')]);
    const c = new NearConnector({ network: 'testnet' });
    await c.use(createAccessKeyPlugin({ network: 'testnet', signIn: { contractId: contract, methodNames: PLAYER_METHODS, allowance: '250000000000000000000000' } }));
    return c;
  })();
  return connectorP;
}

/** Opens the wallet picker, then proves the account to the game server with a signed message. */
export async function signIn(): Promise<string> {
  const c = await connector();
  const w = await c.connect();
  const accounts = await w.getAccounts({ network: 'testnet' });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error('the wallet returned no account');
  const ch = await api<{ message: string; nonce: string; recipient: string }>('/auth/challenge');
  const nonce = Uint8Array.from(atob(ch.nonce), (x) => x.charCodeAt(0));
  const signed = await w.signMessage({ message: ch.message, recipient: ch.recipient, nonce, network: 'testnet', signerId: accountId });
  const r = await api<{ token: string; accountId: string }>('/auth/verify', { ...signed, nonce: ch.nonce, message: ch.message });
  session.set(r.token);
  return r.accountId;
}

export async function signOut(): Promise<void> {
  session.set(null);
  try { const c = await connector(); await c.disconnect(await c.wallet()); } catch { /* not connected */ }
}

interface Outcome { status?: { SuccessValue?: string; Failure?: unknown }; transaction?: { hash: string }; transaction_outcome?: { id: string } }

/** A contract call from the signed-in wallet (signed by the function-call key: no popup). */
export async function call<T>(method: string, args: object): Promise<{ value: T; tx: string }> {
  const c = await connector();
  const w = await c.wallet();
  const out = (await w.signAndSendTransaction({
    receiverId: contract,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args: args as Record<string, unknown>, gas: '50000000000000', deposit: '0' } }],
  })) as unknown as Outcome;
  if (out.status && 'Failure' in out.status && out.status.Failure) {
    const msg = JSON.stringify(out.status.Failure);
    throw new Error(/panicked at[^"]*?: ?([^"\\]+)/.exec(msg)?.[1] ?? /"(Smart contract panicked: [^"]+)"/.exec(msg)?.[1] ?? 'the transaction failed');
  }
  const raw = out.status?.SuccessValue ? atob(out.status.SuccessValue) : '';
  return { value: (raw ? JSON.parse(raw) : undefined) as T, tx: out.transaction?.hash ?? out.transaction_outcome?.id ?? '' };
}
