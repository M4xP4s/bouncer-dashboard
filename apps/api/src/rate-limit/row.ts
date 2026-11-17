import type { Status, UserRow } from '@app/contracts';
import { resetAt, windowStart } from './keys.js';

/** The base limit of a user without a custom one. Not configurable. */
export const DEFAULT_LIMIT = 100;

/**
 * The replies of the row read, in the order the commands are queued:
 * `ZCARD` of the window, `GET` of the custom limit, of the extra grant and
 * of the suspension end, and `HGETALL` of the user hash.
 */
export type RowReplies = [
  used: number,
  limit: string | null,
  extra: string | null,
  suspend: string | null,
  user: Record<string, string>,
];

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Turns one row read and the request's time into the row the dashboard
 * shows. Admission, admin actions and the snapshot all use this function,
 * so there is no second place that computes remaining, status or last
 * reset, and the table cannot disagree with the limiter.
 *
 * Pure: no Redis, no Nest, no clock.
 */
export function buildRow(
  userId: string,
  [used, limitReply, extraReply, suspendReply, user]: RowReplies,
  now: number,
): UserRow {
  const limit = Number(limitReply ?? DEFAULT_LIMIT);
  const extra = Number(extraReply ?? 0);
  const total = limit + extra;

  // Integer arithmetic: `used / total >= 0.9` would depend on rounding.
  let status: Status = 'OK';
  if (used >= total) status = 'Exceeded';
  else if (used * 10 >= total * 9) status = 'Warning';

  // The stored end time decides, not the key's existence: Redis removes an
  // expired key a moment late.
  const suspendedUntil = Number(suspendReply ?? 0);

  return {
    userId,
    used,
    limit,
    extra,
    total,
    // A lowered limit keeps the real usage; only the display is clamped.
    remaining: Math.max(0, total - used),
    status,
    resetAt: iso(resetAt(now)),
    lastRequestAt: user.lastRequestAt ? iso(Number(user.lastRequestAt)) : null,
    // A new hour is a reset too, so this is never older than the window.
    lastResetAt: iso(
      Math.max(windowStart(now), Number(user.lastManualResetAt ?? 0)),
    ),
    suspendedUntil: suspendedUntil > now ? iso(suspendedUntil) : null,
    version: Number(user.v ?? 0),
  };
}
