// How long the contract's free NEAR lasts. Every byte the contract stores locks 0.00001 NEAR
// (1e19 yocto); when the balance can't cover the next write, create_match, seal, settle_match and
// post_offer fail with LackBalanceForState. Pure functions; status.ts feeds them samples.

export const YOCTO_PER_BYTE = 10n ** 19n;
const YOCTO = 10n ** 24n;
const DAY = 86_400_000;

export interface StorageSample { at: number; bytes: number }

export interface Runway {
  /** NEAR not locked for storage */
  free: number;
  bytes: number;
  /** storage growth over the sampled window, bytes per day (null until there's an hour of samples) */
  bytesPerDay: number | null;
  /** when the free NEAR is used up at that rate (ISO date), null if it isn't growing or unknown */
  runsOut: string | null;
  /** NEAR to send so it lasts until `until` (0 if it already does) */
  topUp: number;
  warning: string | null;
}

export const freeNear = (amountYocto: string | bigint, bytes: number, lockedYocto: string | bigint = 0n): number => {
  const free = BigInt(amountYocto) + BigInt(lockedYocto) - BigInt(bytes) * YOCTO_PER_BYTE;
  return Number((free * 10_000n) / YOCTO) / 10_000;
};

/** Keeps samples at least 10 minutes apart and no older than 3 days. */
export function addSample(samples: StorageSample[], s: StorageSample): StorageSample[] {
  const last = samples[samples.length - 1];
  const kept = samples.filter((x) => s.at - x.at <= 3 * DAY);
  if (last && s.at - last.at < 10 * 60_000) return kept;
  return [...kept, s];
}

/** The growth rate from the samples, then the run-out date and the top-up needed to reach `until`. */
export function runway(free: number, bytes: number, samples: StorageSample[], now: number, until: number, contract: string): Runway {
  const first = samples[0];
  const span = first ? now - first.at : 0;
  const bytesPerDay = first && span >= 3600_000 ? Math.max(0, ((bytes - first.bytes) / span) * DAY) : null;
  const nearPerDay = bytesPerDay === null ? null : bytesPerDay / 100_000;
  const daysLeft = nearPerDay ? free / nearPerDay : null;
  const runsOutAt = daysLeft === null ? null : now + daysLeft * DAY;
  const runsOut = runsOutAt === null ? null : new Date(runsOutAt).toISOString().slice(0, 10);
  const needed = nearPerDay ? Math.max(0, ((until - now) / DAY) * nearPerDay - free) : 0;
  const topUp = Math.ceil(needed * 10) / 10;
  let warning: string | null = null;
  if (free < 0.05) warning = `contract ${contract} has ${free} NEAR free for storage: new matches and offers fail (LackBalanceForState). Send NEAR to ${contract}.`;
  else if (runsOutAt !== null && runsOutAt < until) warning = `contract storage grows ~${Math.round(bytesPerDay! / 1000)} KB/day and uses up its ${free} free NEAR around ${runsOut}, before ${new Date(until).toISOString().slice(0, 10)}: send ${topUp} NEAR to ${contract}.`;
  else if (free < 0.5) warning = `contract ${contract} has only ${free} NEAR free for storage.`;
  return { free, bytes, bytesPerDay: bytesPerDay === null ? null : Math.round(bytesPerDay), runsOut, topUp, warning };
}
