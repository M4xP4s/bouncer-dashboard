// UTC clock-hour windows; all times are milliseconds since the epoch.

const HOUR_MS = 3_600_000;

/** Start of the UTC clock hour that `now` falls in. */
export const windowStart = (now: number): number => now - (now % HOUR_MS);

/** The next hour boundary: when the window that holds `now` ends. */
export const resetAt = (now: number): number => windowStart(now) + HOUR_MS;

/**
 * `Retry-After`: whole seconds until the window ends, rounded up so the
 * caller never retries early, and at least 1.
 */
export const retryAfterSeconds = (now: number): number =>
  Math.max(1, Math.ceil((resetAt(now) - now) / 1000));

// Keep the old hour for slow clocks: deleting it at the boundary could
// recreate an empty bucket and admit requests beyond that hour’s cap.
export const windowExpiry = (now: number): number => resetAt(now) + HOUR_MS;

/** UTC day for the daily rejection count. */
export const utcDay = (now: number): string =>
  new Date(now).toISOString().slice(0, 10);

/** Counter field within the request's UTC hour, from 0 through 59. */
export const minuteInWindow = (now: number): number =>
  Math.floor((now - windowStart(now)) / 60_000);

/** Retain the oldest hour needed by a rolling 24-hour chart. */
export const counterExpiry = (now: number): number =>
  windowStart(now) + 25 * HOUR_MS;

export const keys = {
  /** Sorted set: one member per request counted in this window. */
  window: (userId: string, now: number) =>
    `rl:win:${userId}:${windowStart(now)}`,
  /** Extra requests granted for this window only. */
  extra: (userId: string, now: number) =>
    `rl:extra:${userId}:${windowStart(now)}`,
  /** Custom base limit. Absent means the default. */
  limit: (userId: string) => `rl:limit:${userId}`,
  /** End time of a suspension of throttling, in milliseconds. */
  suspend: (userId: string) => `rl:suspend:${userId}`,
  /** Hash: version, re-arm generation, last request, last manual reset. */
  user: (userId: string) => `rl:user:${userId}`,
  /** At most 100 recent records, expiring 24 hours after the last write. */
  history: (userId: string) => `rl:hist:${userId}`,
  /** Admitted and denied counts for each minute of a window. */
  stat: (userId: string, now: number) =>
    `rl:stat:${userId}:${windowStart(now)}`,
  /** Rejections in one UTC day, expiring 48 hours after the last write. */
  denied: (now: number) => `rl:denied:${utcDay(now)}`,
  /** A delayed rejection can only mark the generation it was decided in. */
  notified: (userId: string, now: number, generation: number) =>
    `rl:notified:${userId}:${windowStart(now)}:${generation}`,
};

export const userFields = {
  version: 'v',
  generation: 'g',
  lastRequestAt: 'lastRequestAt',
  lastManualResetAt: 'lastManualResetAt',
} as const;

export const statField = (denied: boolean, minute: number): string =>
  `${denied ? 'd' : 'a'}:${minute}`;
