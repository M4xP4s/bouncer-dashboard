import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { RequestOutcome, RequestRecord, UserRow } from '@app/contracts';
import { REDIS, type RedisClient } from '../redis/redis.module.js';
import {
  counterExpiry,
  keys,
  minuteInWindow,
  statField,
  userFields,
  windowExpiry,
} from './keys.js';
import { buildRow, type RowReplies } from './row.js';

// Only Redis failures become 503; programming errors remain defects.
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

// Quota decisions are atomic; history and notifications follow best-effort.
@Injectable()
export class RateLimitStore {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  // Write then read inside MULTI/EXEC: concurrent requests cannot share a slot.
  async admit(userId: string, now: number): Promise<Admission> {
    const requestId = randomUUID();
    const window = keys.window(userId, now);
    const user = keys.user(userId);

    const replies = await this.transaction((multi) => {
      multi
        .zAdd(window, { score: now, value: requestId })
        // Inside the transaction: set separately, a crash between the two
        // commands would leave a key that never expires.
        .pExpireAt(window, windowExpiry(now))
        .hIncrBy(user, userFields.version, 1)
        .hSet(user, userFields.lastRequestAt, `${now}`);
      this.appendRowRead(multi, userId, now);
    });
    // The last five replies belong to appendRowRead; Redis's dynamic queue
    // loses its tuple type, so the assertion stays at this library boundary.
    const [count, limit, extra, suspend, hash] = replies.slice(
      -5,
    ) as RowReplies;

    // The count includes this request, so "at the cap" is still admitted.
    const counted = buildRow(userId, [count, limit, extra, suspend, hash], now);
    let outcome: RequestOutcome = 'allowed';
    if (count > counted.total) {
      outcome = counted.suspendedUntil === null ? 'denied' : 'bypassed';
    }

    // A rejected request's own entry is removed by `recordOutcome`, so the
    // row that describes the rejection does not count it.
    const row =
      outcome === 'denied'
        ? buildRow(userId, [count - 1, limit, extra, suspend, hash], now)
        : counted;
    return {
      outcome,
      row,
      requestId,
      generation: Number(hash[userFields.generation] ?? 0),
    };
  }

  /**
   * Bounded history and counters follow every decision. A rejection removes
   * only its own member, even if a reset happened since it was decided.
   * A failed cleanup can consume later-added capacity but cannot admit more.
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
        .lTrim(keys.history(userId), 0, 99)
        .expire(keys.history(userId), 86_400)
        .hIncrBy(
          keys.stat(userId, now),
          statField(denied, minuteInWindow(now)),
          1,
        )
        .pExpireAt(keys.stat(userId, now), counterExpiry(now));
      if (denied) {
        multi
          .incr(keys.denied(now))
          .expire(keys.denied(now), 172_800)
          // Never use a newly read generation: an admin action may already
          // have re-armed the next alert while this rejection was delayed.
          .set(keys.notified(userId, now, admission.generation), '1', {
            condition: 'NX',
            expiration: { type: 'PXAT', value: windowExpiry(now) },
          });
      }
    });
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
    const call = multi.exec();
    try {
      return await call;
    } catch (cause) {
      throw new StoreUnavailable(cause);
    }
  }
}
