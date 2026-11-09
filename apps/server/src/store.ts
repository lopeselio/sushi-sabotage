import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Accusation, LogEntry, Result, Setup } from '@sushi/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Proof bundles for finished matches: everything needed to replay and check one.

export interface OpeningRec { caster: number; target: number; card: string; tick: number; salt: string }

export interface MatchRecord {
  id: string;
  mode: 'solo' | 'room' | 'league';
  createdAt: number;
  setup: Setup;
  seats: { chef: string | null; name: string; kind: 'human' | 'bot' | 'guest'; account?: string }[];
  seedHash: string;
  seed?: string;
  fee: number;
  ranked: boolean;
  log: LogEntry[];
  seals: string[];
  openings: OpeningRec[];
  accusations: Accusation[];
  results?: Result[];
  stateHash?: string;
  txs: { what: string; hash: string }[];
  lines: SignedLine[];
  settled: boolean;
  error?: string;
}

const dir = join(config.dataDir, 'matches');
mkdirSync(dir, { recursive: true });
const mem = new Map<string, MatchRecord>();

export function saveMatch(m: MatchRecord): void {
  mem.set(m.id, m);
  writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m));
}

export function loadMatch(id: string): MatchRecord | null {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try { return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as MatchRecord; } catch { return null; }
}

export function recentMatches(n = 20): MatchRecord[] {
  const ids = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  return ids.map((id) => loadMatch(id)).filter((m): m is MatchRecord => !!m).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
}

// small key-value file for market demand and agent memory
const kvFile = join(config.dataDir, 'kv.json');
let kv: Record<string, unknown> = (() => { try { return JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, unknown>; } catch { return {}; } })();
export const kvGet = <T>(k: string, d: T): T => (k in kv ? (kv[k] as T) : d);
export function kvSet(k: string, v: unknown): void {
  kv = { ...kv, [k]: v };
  writeFileSync(kvFile, JSON.stringify(kv));
}
