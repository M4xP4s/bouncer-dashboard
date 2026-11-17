import type { Status, UserRow } from '@app/contracts';
import { resetAt, userFields, windowStart } from './keys.js';

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

function statusFor(used: number, total: number): Status {
  if (used >= total) return 'Exceeded';
  // Integer arithmetic preserves the threshold for non-round limits.
  if (used * 10 >= total * 9) return 'Warning';
  return 'OK';
}

// Shared row calculation keeps remaining quota, status and reset time consistent.
export function buildRow(
  userId: string,
  [used, limitReply, extraReply, suspendReply, user]: RowReplies,
  now: number,
): UserRow {
  const limit = Number(limitReply ?? DEFAULT_LIMIT);
  const extra = Number(extraReply ?? 0);
  const total = limit + extra;

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
    status: statusFor(used, total),
    resetAt: iso(resetAt(now)),
    lastRequestAt: user[userFields.lastRequestAt]
      ? iso(Number(user[userFields.lastRequestAt]))
      : null,
    // A new hour is a reset too, so this is never older than the window.
    lastResetAt: iso(
      Math.max(
        windowStart(now),
        Number(user[userFields.lastManualResetAt] ?? 0),
      ),
    ),
    suspendedUntil: suspendedUntil > now ? iso(suspendedUntil) : null,
    version: Number(user[userFields.version] ?? 0),
  };
}
