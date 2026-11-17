import { mockDeep } from 'vitest-mock-extended';
import type { RequestOutcome } from '@app/contracts';
import type { RedisClient } from '../redis/redis.module.js';
import {
  type Admission,
  RateLimitStore,
  StoreUnavailable,
} from './rate-limit.store.js';
import { buildRow, type RowReplies } from './row.js';

const now = Date.parse('2026-11-16T10:42:00.000Z');
const windowKey = `rl:win:user-01:${Date.parse('2026-11-16T10:00:00.000Z')}`;
const hour = Date.parse('2026-11-16T10:00:00.000Z');
const expiry = Date.parse('2026-11-16T12:00:00.000Z');

/**
 * A store on a mocked Redis client (the mock library, nothing running).
 * `exec` answers with the replies of the four admission writes followed by
 * the given row read, the order in which the store queues them.
 */
function storeWith(
  used: number,
  {
    limit = null,
    extra = null,
    suspend = null,
    generation,
  }: {
    limit?: string | null;
    extra?: string | null;
    suspend?: string | null;
    generation?: string;
  } = {},
) {
  const redis = mockDeep<RedisClient>();
  type Transaction = ReturnType<typeof redis.multi<'typed'>>;
  const multi = mockDeep<Transaction>();
  Object.defineProperty(redis, 'isReady', { value: true, configurable: true });
  redis.multi.mockReturnValue(multi);
  multi.zAdd.mockReturnThis();
  multi.pExpireAt.mockReturnThis();
  multi.hIncrBy.mockReturnThis();
  multi.hSet.mockReturnThis();
  multi.zCard.mockReturnThis();
  multi.get.mockReturnThis();
  multi.hGetAll.mockReturnThis();
  multi.zRem.mockReturnThis();
  multi.lPush.mockReturnThis();
  multi.lTrim.mockReturnThis();
  multi.expire.mockReturnThis();
  multi.incr.mockReturnThis();
  multi.set.mockReturnThis();
  multi.del.mockReturnThis();
  multi.incrBy.mockReturnThis();
  const user: Record<string, string> = {
    v: `${used}`,
    lastRequestAt: `${now}`,
  };
  if (generation !== undefined) {
    user.g = generation;
  }
  const row: RowReplies = [used, limit, extra, suspend, user];
  // Redis brands decoded reply types; dynamic fixture arrays need the one
  // library-boundary assertion while all command arguments remain typed.
  const setReplies = (values: unknown[]) =>
    multi.exec.mockResolvedValue(
      values as Awaited<ReturnType<Transaction['exec']>>,
    );
  setReplies([1, 1, used, 0, ...row]);
  return { store: new RateLimitStore(redis), redis, multi, setReplies };
}

describe('RateLimitStore.admit', () => {
  it('admits a request below the cap and returns the row it produced', async () => {
    const { store } = storeWith(1);

    const admission = await store.admit('user-01', now);

    expect(admission.outcome).toBe('allowed');
    expect(admission.row).toMatchObject({
      userId: 'user-01',
      used: 1,
      total: 100,
      remaining: 99,
      version: 1,
      lastRequestAt: '2026-11-16T10:42:00.000Z',
    });
  });

  it('admits the request that reaches the cap', async () => {
    const { store } = storeWith(100);

    const admission = await store.admit('user-01', now);

    expect(admission.outcome).toBe('allowed');
    expect(admission.row.remaining).toBe(0);
  });

  it('rejects the request above the cap and leaves it out of the row', async () => {
    const { store } = storeWith(101);

    const admission = await store.admit('user-01', now);

    expect(admission.outcome).toBe('denied');
    // The rejected request's own entry is removed afterwards, so the row
    // does not count it.
    expect(admission.row).toMatchObject({ used: 100, remaining: 0 });
  });

  it('applies a custom limit', async () => {
    expect(
      (await storeWith(5, { limit: '5' }).store.admit('user-01', now)).outcome,
    ).toBe('allowed');
    expect(
      (await storeWith(6, { limit: '5' }).store.admit('user-01', now)).outcome,
    ).toBe('denied');
  });

  it('raises the cap by the extra grant', async () => {
    expect(
      (await storeWith(110, { extra: '10' }).store.admit('user-01', now))
        .outcome,
    ).toBe('allowed');
    expect(
      (await storeWith(111, { extra: '10' }).store.admit('user-01', now))
        .outcome,
    ).toBe('denied');
  });

  it('admits over the cap as bypassed while throttling is suspended', async () => {
    const { store } = storeWith(101, { suspend: `${now + 1}` });

    const admission = await store.admit('user-01', now);

    expect(admission.outcome).toBe('bypassed');
    // A bypassed request stays counted.
    expect(admission.row).toMatchObject({ used: 101, remaining: 0 });
  });

  it("rejects when the suspension has ended by the request's time", async () => {
    const { store } = storeWith(101, { suspend: `${now}` });

    expect((await store.admit('user-01', now)).outcome).toBe('denied');
  });

  it('counts, expires and reads in one transaction', async () => {
    const { store, redis, multi } = storeWith(1);

    const { requestId } = await store.admit('user-01', now);

    expect(redis.multi).toHaveBeenCalledOnce();
    expect(multi.exec).toHaveBeenCalledOnce();
    expect(multi.zAdd).toHaveBeenCalledWith(windowKey, {
      score: now,
      value: requestId,
    });
    expect(multi.pExpireAt).toHaveBeenCalledWith(
      windowKey,
      Date.parse('2026-11-16T12:00:00.000Z'),
    );
    expect(multi.hIncrBy).toHaveBeenCalledWith('rl:user:user-01', 'v', 1);
    expect(multi.hSet).toHaveBeenCalledWith(
      'rl:user:user-01',
      'lastRequestAt',
      `${now}`,
    );
    // The limit, the grant and the suspension are read after the write, in
    // the same transaction: never before it.
    expect(multi.zAdd).toHaveBeenCalledBefore(multi.zCard);
    expect(multi.zCard).toHaveBeenCalledWith(windowKey);
    expect(multi.get.mock.calls).toEqual([
      ['rl:limit:user-01'],
      [`rl:extra:user-01:${Date.parse('2026-11-16T10:00:00.000Z')}`],
      ['rl:suspend:user-01'],
    ]);
    expect(multi.hGetAll).toHaveBeenCalledWith('rl:user:user-01');
  });

  it('gives every request its own ID', async () => {
    const { store } = storeWith(1);

    const first = await store.admit('user-01', now);
    const second = await store.admit('user-01', now);

    expect(first.requestId).not.toBe(second.requestId);
  });

  it.each([
    [undefined, 0],
    ['7', 7],
  ])(
    'returns the generation the transaction read (%s)',
    async (stored, expected) => {
      const { store } = storeWith(101, { generation: stored });
      expect((await store.admit('user-01', now)).generation).toBe(expected);
    },
  );

  it('does not convert a command-building defect into StoreUnavailable', async () => {
    const { store, multi } = storeWith(1);
    const defect = new TypeError('bad command argument');
    multi.zAdd.mockImplementation(() => {
      throw defect;
    });

    await expect(store.admit('user-01', now)).rejects.toBe(defect);
    expect(multi.exec).not.toHaveBeenCalled();
  });

  it('does not convert a row-building defect into StoreUnavailable', async () => {
    const { store, setReplies } = storeWith(1);
    setReplies([
      1,
      1,
      1,
      0,
      1,
      null,
      null,
      null,
      {
        lastRequestAt: 'not a timestamp',
      },
    ]);

    await expect(store.admit('user-01', now)).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('fails at once, sending nothing, while the connection is known to be down', async () => {
    // The client would hold a transaction until its reconnect attempt
    // settles, which is seconds when Redis hangs.
    const { store, redis } = storeWith(1);
    Object.defineProperty(redis, 'isReady', { value: false });

    await expect(store.admit('user-01', now)).rejects.toBeInstanceOf(
      StoreUnavailable,
    );
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('turns a Redis failure into StoreUnavailable and keeps the cause', async () => {
    const { store, multi } = storeWith(1);
    const cause = new Error('The client is offline');
    multi.exec.mockRejectedValue(cause);

    const failure = await store.admit('user-01', now).catch((e) => e);

    expect(failure).toBeInstanceOf(StoreUnavailable);
    expect(failure.cause).toBe(cause);
  });
});

describe('RateLimitStore.recordOutcome', () => {
  const decision = (outcome: RequestOutcome): Admission => ({
    outcome,
    requestId: 'request-1',
    generation: 7,
    row: buildRow('user-01', [100, null, null, null, {}], now),
  });

  it.each(['allowed', 'bypassed'] as const)(
    'records %s history and its admitted minute in one transaction, and resolves false',
    async (outcome) => {
      const { store, redis, multi } = storeWith(100);
      const admission = decision(outcome);

      await expect(
        store.recordOutcome('user-01', now, admission),
      ).resolves.toBe(false);

      expect(redis.multi).toHaveBeenCalledOnce();
      expect(multi.exec).toHaveBeenCalledOnce();
      expect(multi.lPush).toHaveBeenCalledExactlyOnceWith(
        'rl:hist:user-01',
        JSON.stringify({
          id: 'request-1',
          at: new Date(now).toISOString(),
          outcome,
          remaining: 0,
        }),
      );
      expect(multi.lTrim).toHaveBeenCalledExactlyOnceWith(
        'rl:hist:user-01',
        0,
        99,
      );
      expect(multi.expire).toHaveBeenCalledExactlyOnceWith(
        'rl:hist:user-01',
        86_400,
      );
      expect(multi.hIncrBy).toHaveBeenCalledExactlyOnceWith(
        `rl:stat:user-01:${hour}`,
        'a:42',
        1,
      );
      expect(multi.pExpireAt).toHaveBeenCalledExactlyOnceWith(
        `rl:stat:user-01:${hour}`,
        Date.parse('2026-11-17T11:00:00.000Z'),
      );
      expect(multi.zRem).not.toHaveBeenCalled();
      expect(multi.incr).not.toHaveBeenCalled();
      expect(multi.set).not.toHaveBeenCalled();
    },
  );

  it('removes exactly the rejected request ID and counts the rejected minute and day with expiry', async () => {
    const { store, redis, multi, setReplies } = storeWith(101);
    const admission = decision('denied');
    setReplies([1, 1, 'OK', 1, 1, 1, 1, 1, 'OK']);

    await expect(store.recordOutcome('user-01', now, admission)).resolves.toBe(
      true,
    );

    expect(redis.multi).toHaveBeenCalledOnce();
    expect(multi.exec).toHaveBeenCalledOnce();
    expect(multi.zRem).toHaveBeenCalledExactlyOnceWith(
      windowKey,
      admission.requestId,
    );
    expect(multi.zRem).toHaveBeenCalledBefore(multi.lPush);
    expect(multi.lPush).toHaveBeenCalledExactlyOnceWith(
      'rl:hist:user-01',
      JSON.stringify({
        id: 'request-1',
        at: new Date(now).toISOString(),
        outcome: 'denied',
        remaining: 0,
      }),
    );
    expect(multi.lTrim).toHaveBeenCalledExactlyOnceWith(
      'rl:hist:user-01',
      0,
      99,
    );
    expect(multi.hIncrBy).toHaveBeenCalledExactlyOnceWith(
      `rl:stat:user-01:${hour}`,
      'd:42',
      1,
    );
    expect(multi.pExpireAt).toHaveBeenCalledExactlyOnceWith(
      `rl:stat:user-01:${hour}`,
      Date.parse('2026-11-17T11:00:00.000Z'),
    );
    expect(multi.incr).toHaveBeenCalledExactlyOnceWith('rl:denied:2026-11-16');
    expect(multi.expire.mock.calls).toEqual([
      ['rl:hist:user-01', 86_400],
      ['rl:denied:2026-11-16', 172_800],
    ]);
    expect(multi.set).toHaveBeenCalledExactlyOnceWith(
      `rl:notified:user-01:${hour}:7`,
      '1',
      {
        condition: 'NX',
        expiration: { type: 'PXAT', value: expiry },
      },
    );
    expect(multi.hGetAll).not.toHaveBeenCalled();
  });

  it('resolves false when the flag already existed', async () => {
    const { store, setReplies } = storeWith(101);
    setReplies([1, 1, 'OK', 1, 1, 1, 1, 1, null]);

    await expect(
      store.recordOutcome('user-01', now, decision('denied')),
    ).resolves.toBe(false);
  });

  it('fails at once while the connection is down', async () => {
    const { store, redis } = storeWith(101);
    Object.defineProperty(redis, 'isReady', { value: false });

    await expect(
      store.recordOutcome('user-01', now, decision('denied')),
    ).rejects.toBeInstanceOf(StoreUnavailable);
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('turns a Redis failure into StoreUnavailable without retrying', async () => {
    const { store, multi } = storeWith(101);
    const cause = new Error('lost reply');
    multi.exec.mockRejectedValue(cause);

    await expect(
      store.recordOutcome('user-01', now, decision('denied')),
    ).rejects.toMatchObject({ cause });
    expect(multi.exec).toHaveBeenCalledOnce();
  });
});
