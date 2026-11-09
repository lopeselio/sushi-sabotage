import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { accessKey } from './chain.ts';
import { config } from './config.ts';

// Wallet sign-in: the browser signs a NEP-413 message with the wallet; we check the signature and
// that the key belongs to the account, then hand back a session token (HMAC, 12 h).

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}

const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const str = (s: string): Uint8Array => { const e = new TextEncoder().encode(s); return concat(u32(e.length), e); };
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** sha256 of the NEP-413 borsh payload. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const tag = u32(2 ** 31 + 413);
  return sha256(concat(tag, str(message), nonce, str(recipient), new Uint8Array([0])));
}

// one-time challenges
const challenges = new Map<string, number>();
export function challenge(): { message: string; nonce: string; recipient: string } {
  const nonce = randomBytes(32).toString('base64');
  challenges.set(nonce, Date.now() + 5 * 60_000);
  return { message: 'Sign in to Sushi Sabotage', nonce, recipient: config.contract };
}

export interface SignedMessage { accountId: string; publicKey: string; signature: string; nonce: string; message: string }

export async function verifySignIn(m: SignedMessage): Promise<string> {
  const exp = challenges.get(m.nonce);
  if (!exp || exp < Date.now()) throw new Error('sign-in challenge expired; try again');
  challenges.delete(m.nonce);
  if (m.message !== 'Sign in to Sushi Sabotage') throw new Error('unexpected message');
  if (!m.publicKey.startsWith('ed25519:')) throw new Error('only ed25519 keys are supported');
  const pk = base58Decode(m.publicKey.slice(8));
  const sig = Uint8Array.from(Buffer.from(m.signature, 'base64'));
  const hash = nep413Hash(m.message, Uint8Array.from(Buffer.from(m.nonce, 'base64')), config.contract);
  if (!ed25519.verify(sig, hash, pk)) throw new Error('signature does not verify');
  const key = await accessKey(m.accountId, m.publicKey);
  if (!key) throw new Error('that key is not a key of this account');
  if (key.permission !== 'FullAccess') throw new Error('sign-in needs a full-access key (a wallet signature)');
  return issue(m.accountId);
}

function mac(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
export function issue(accountId: string): string {
  const payload = `${accountId}.${Date.now() + 12 * 3600_000}`;
  return `${Buffer.from(payload).toString('base64url')}.${mac(payload)}`;
}
/** The account a session token belongs to, or null. */
export function sessionAccount(token: string | undefined): string | null {
  if (!token) return null;
  const [p, m] = token.split('.');
  if (!p || !m) return null;
  const payload = Buffer.from(p, 'base64url').toString('utf8');
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(m);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const dot = payload.lastIndexOf('.');
  if (Number(payload.slice(dot + 1)) < Date.now()) return null;
  return payload.slice(0, dot);
}
