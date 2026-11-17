import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorReply } from 'redis';
import type {
  HistoryBucket,
  HistoryRange,
  RequestOutcome,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { REDIS, type RedisClient } from '../redis/redis.module.js';
import {
  counterExpiry,
  DENIED_COUNT_TTL_SECONDS,
  HISTORY_MAX_RECORDS,
  HISTORY_TTL_SECONDS,
  HISTORY_TTL_MS,
  HOUR_MS,
  HOURS_PER_DAY,
  keys,
  MINUTE_MS,
  MINUTES_PER_HOUR,
  minuteInWindow,
  statField,
  userFields,
  windowExpiry,
  windowStart,
} from './keys.js';
import { buildRow, ROW_REPLY_COUNT, type RowReplies } from './row.js';

type RedisTransaction = ReturnType<RedisClient['multi']>;

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

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function bucketStarts(latest: number, count: number, stepMs: number): number[] {
  return Array.from(
    { length: count },
    (_, index) => latest - (count - 1 - index) * stepMs,
  );
}

function historyBucket(
  time: number,
  counts: Record<string, string>,
  firstMinute: number,
  minuteCount: number,
): HistoryBucket {
  let allowed = 0;
  let denied = 0;
  for (let minute = firstMinute; minute < firstMinute + minuteCount; minute++) {
    allowed += Number(counts[statField(false, minute)] ?? 0);
    denied += Number(counts[statField(true, minute)] ?? 0);
  }
  const start = new Date(time).toISOString();
  return { start, allowed, denied };
}

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

  async reset(userId: string, now: number): Promise<UserRow> {
    return this.adminAction(userId, now, (multi) => {
      multi
        .del(keys.window(userId, now))
        .del(keys.extra(userId, now))
        .hSet(keys.user(userId), userFields.lastManualResetAt, `${now}`)
        .hIncrBy(keys.user(userId), userFields.generation, 1);
    });
  }

  async setLimit(userId: string, now: number, limit: number): Promise<UserRow> {
    return this.adminAction(userId, now, (multi) => {
      // Every successful save re-arms, including decreases and same values.
      multi
        .set(keys.limit(userId), `${limit}`)
        .hIncrBy(keys.user(userId), userFields.generation, 1);
    });
  }

  async suspend(
    userId: string,
    now: number,
    minutes: number,
  ): Promise<UserRow> {
    const suspendedUntilMs = now + minutes * MINUTE_MS;
    return this.adminAction(userId, now, (multi) => {
      multi.set(keys.suspend(userId), `${suspendedUntilMs}`, {
        expiration: { type: 'PXAT', value: suspendedUntilMs },
      });
    });
  }

  async unsuspend(userId: string, now: number): Promise<UserRow> {
    return this.adminAction(userId, now, (multi) => {
      multi.del(keys.suspend(userId));
    });
  }

  async addExtra(
    userId: string,
    now: number,
    amount: number,
  ): Promise<UserRow> {
    return this.adminAction(userId, now, (multi) => {
      // Usage is never initialized here: a concurrent admission may own it.
      multi
        .incrBy(keys.extra(userId, now), amount)
        .pExpireAt(keys.extra(userId, now), windowExpiry(now))
        .hIncrBy(keys.user(userId), userFields.generation, 1);
    });
  }

  /** Read each row and its version together in one transaction. */
  async snapshot(userIds: readonly string[], now: number): Promise<UserRow[]> {
    const replies = await this.transaction((multi) => {
      for (const userId of userIds) this.appendRowRead(multi, userId, now);
    });
    return userIds.map((userId, index) =>
      buildRow(
        userId,
        replies.slice(
          index * ROW_REPLY_COUNT,
          (index + 1) * ROW_REPLY_COUNT,
        ) as RowReplies,
        now,
      ),
    );
  }

  async detail(userId: string, now: number): Promise<UserDetail> {
    const replies = await this.transaction((multi) => {
      this.appendRowRead(multi, userId, now);
      multi.lRange(keys.history(userId), 0, HISTORY_MAX_RECORDS - 1);
    });
    const recentRequests = (replies[ROW_REPLY_COUNT] as string[])
      .map((record) => JSON.parse(record) as RequestRecord)
      .filter((record) => Date.parse(record.at) > now - HISTORY_TTL_MS)
      .sort(
        (a, b) => Date.parse(b.at) - Date.parse(a.at) || compareIds(a.id, b.id),
      );
    const row = buildRow(
      userId,
      replies.slice(0, ROW_REPLY_COUNT) as RowReplies,
      now,
    );
    return { row, recentRequests };
  }

  async history(
    userId: string,
    range: HistoryRange,
    now: number,
  ): Promise<HistoryBucket[]> {
    const currentHour = windowStart(now);
    const hours =
      range === 'hour'
        ? [currentHour - HOUR_MS, currentHour]
        : bucketStarts(currentHour, HOURS_PER_DAY, HOUR_MS);
    const replies = await this.transaction((multi) => {
      for (const time of hours) multi.hGetAll(keys.stat(userId, time));
    });
    const counts = replies as Record<string, string>[];
    if (range === 'hour') {
      const currentMinute = now - (now % MINUTE_MS);
      return bucketStarts(currentMinute, MINUTES_PER_HOUR, MINUTE_MS).map(
        (time) => {
          const values = counts[time < currentHour ? 0 : 1];
          return historyBucket(time, values, minuteInWindow(time), 1);
        },
      );
    }
    return hours.map((time, index) =>
      historyBucket(time, counts[index], 0, MINUTES_PER_HOUR),
    );
  }

  async denied429(now: number): Promise<number> {
    const replies = await this.transaction((multi) => {
      multi.get(keys.denied(now));
    });
    return Number(replies[0] ?? 0);
  }

  /** A row and its version are read after the action, in the same transaction. */
  private async adminAction(
    userId: string,
    now: number,
    write: (multi: RedisTransaction) => void,
  ): Promise<UserRow> {
    const replies = await this.transaction((multi) => {
      write(multi);
      multi.hIncrBy(keys.user(userId), userFields.version, 1);
      this.appendRowRead(multi, userId, now);
    });
    // appendRowRead fixes the shape of the trailing replies.
    return buildRow(userId, replies.slice(-ROW_REPLY_COUNT) as RowReplies, now);
  }

  /** One command order for every row, paired with RowReplies and buildRow. */
  private appendRowRead(
    multi: RedisTransaction,
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
    queue: (multi: RedisTransaction) => void,
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
