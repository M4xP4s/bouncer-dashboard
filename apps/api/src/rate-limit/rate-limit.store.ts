import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorReply } from 'redis';
import type { RequestOutcome, RequestRecord, UserRow } from '@app/contracts';
import { REDIS, type RedisClient } from '../redis/redis.module.js';
import {
  counterExpiry,
  DENIED_COUNT_TTL_SECONDS,
  HISTORY_MAX_RECORDS,
  HISTORY_TTL_SECONDS,
  keys,
  minuteInWindow,
  statField,
  userFields,
  windowExpiry,
} from './keys.js';
import { buildRow, ROW_REPLY_COUNT, type RowReplies } from './row.js';

// Connection/execution failures become 503; Redis error replies remain 500.
export class StoreUnavailable extends Error {
  constructor(cause: unknown) {
    super('The rate limit store is unavailable.', { cause });
  }
}

/** The decision for one request and the row that decision produced. */
export interface Admission {
  outcome: RequestOutcome;
  /** The user's state right after this request. `x-count` comes from it. */
  row: UserRow;
  /** This request's member in the window set. */
  requestId: string;
  /** Re-arm generation read with the decision, never read again later. */
  generation: number;
}

// `used` includes this request, so a request at the cap is still admitted.
function outcomeFor(row: UserRow): RequestOutcome {
  if (row.used <= row.total) return 'allowed';
  return row.suspendedUntil === null ? 'denied' : 'bypassed';
}

const withoutRequest = ([used, ...rest]: RowReplies): RowReplies => [
  used - 1,
  ...rest,
];

const generationOf = ([, , , , user]: RowReplies): number =>
  Number(user[userFields.generation] ?? 0);

// Quota decisions are atomic; bookkeeping tolerates unavailability, not error replies.
@Injectable()
export class RateLimitStore {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  // Write then read inside MULTI/EXEC: concurrent requests cannot share a slot.
  async admit(userId: string, now: number): Promise<Admission> {
    const requestId = randomUUID();
    const windowKey = keys.window(userId, now);
    const userKey = keys.user(userId);

    const replies = await this.transaction((multi) => {
      multi
        .zAdd(windowKey, { score: now, value: requestId })
        // Inside the transaction: set separately, a crash between the two
        // commands would leave a key that never expires.
        .pExpireAt(windowKey, windowExpiry(now))
        .hIncrBy(userKey, userFields.version, 1)
        .hSet(userKey, userFields.lastRequestAt, `${now}`);
      this.appendRowRead(multi, userId, now);
    });
    // The trailing replies belong to appendRowRead; Redis's dynamic queue
    // loses its tuple type, so the assertion stays at this library boundary.
    const rowReplies = replies.slice(-ROW_REPLY_COUNT) as RowReplies;

    let row = buildRow(userId, rowReplies, now);
    const outcome = outcomeFor(row);
    // recordOutcome drops a rejected request's entry, so its row excludes it.
    if (outcome === 'denied') {
      row = buildRow(userId, withoutRequest(rowReplies), now);
    }
    return { outcome, row, requestId, generation: generationOf(rowReplies) };
  }

  /**
   * Bounded history and counters follow every decision. A rejection removes
   * only its own member, even if a reset happened since it was decided.
   * A failed cleanup can consume later-added capacity but cannot admit more.
   * Returns true when this rejection claims the notification flag.
   */
  async recordOutcome(
    userId: string,
    now: number,
    admission: Admission,
  ): Promise<boolean> {
    const denied = admission.outcome === 'denied';
    const record: RequestRecord = {
      id: admission.requestId,
      at: new Date(now).toISOString(),
      outcome: admission.outcome,
      remaining: admission.row.remaining,
    };
    const replies = await this.transaction((multi) => {
      if (denied) {
        multi.zRem(keys.window(userId, now), admission.requestId);
      }
      multi
        .lPush(keys.history(userId), JSON.stringify(record))
        .lTrim(keys.history(userId), 0, HISTORY_MAX_RECORDS - 1)
        .expire(keys.history(userId), HISTORY_TTL_SECONDS)
        .hIncrBy(
          keys.stat(userId, now),
          statField(denied, minuteInWindow(now)),
          1,
        )
        .pExpireAt(keys.stat(userId, now), counterExpiry(now));
      if (denied) {
        multi
          .incr(keys.denied(now))
          .expire(keys.denied(now), DENIED_COUNT_TTL_SECONDS)
          // Never use a newly read generation: an admin action may already
          // have re-armed the next alert while this rejection was delayed.
          .set(keys.notified(userId, now, admission.generation), '1', {
            condition: 'NX',
            expiration: { type: 'PXAT', value: windowExpiry(now) },
          });
      }
    });
    // For a rejection, SET NX is the last command; OK means we claimed the flag.
    return denied && replies.at(-1) === 'OK';
  }

  /** One command order for every row, paired with RowReplies and buildRow. */
  private appendRowRead(
    multi: ReturnType<typeof this.redis.multi<'typed'>>,
    userId: string,
    now: number,
  ): void {
    multi
      .zCard(keys.window(userId, now))
      .get(keys.limit(userId))
      .get(keys.extra(userId, now))
      .get(keys.suspend(userId))
      .hGetAll(keys.user(userId));
  }

  /** Fail fast while disconnected; wrap only execution, never our own code. */
  private async transaction(
    queue: (multi: ReturnType<typeof this.redis.multi<'typed'>>) => void,
  ): Promise<unknown[]> {
    // The client otherwise holds MULTI until a reconnect attempt settles and
    // might apply a mutation after its caller has already given up.
    if (!this.redis.isReady) {
      throw new StoreUnavailable(new Error('The Redis connection is down.'));
    }
    const multi = this.redis.multi();
    queue(multi);
    const execution = multi.exec();
    try {
      return await execution;
    } catch (cause) {
      if (cause instanceof ErrorReply) throw cause;
      throw new StoreUnavailable(cause);
    }
  }
}
