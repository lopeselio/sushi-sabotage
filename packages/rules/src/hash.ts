import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** Canonical JSON: object keys sorted, so the same state always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/**
 * A sabotage seal. The same string format is checked by the contract:
 * sha256("{match}|{caster}|{target}|{card}|{tick}|{salt}")
 */
export const sealPreimage = (o: { match: string; caster: number; target: number; card: string; tick: number; salt: string }): string =>
  `${o.match}|${o.caster}|${o.target}|${o.card}|${o.tick}|${o.salt}`;
export const sealOf = (o: Parameters<typeof sealPreimage>[0]): string => sha256Hex(sealPreimage(o));
