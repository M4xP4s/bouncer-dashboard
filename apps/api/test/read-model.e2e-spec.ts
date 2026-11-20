import type {
  Analytics,
  HistoryBucket,
  HistoryRange,
  Status,
} from '@app/contracts';
import {
  bodyOf,
  HOUR_MS,
  MINUTE_MS,
  NEXT_HOUR,
  type TestApplication,
  TEST_NOW,
  useFrozenApplication,
} from './support/application.js';

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const analyticsOf = async (api: TestApplication) =>
  bodyOf<Analytics>(await api.admin('get', '/analytics').expect(200));

const historyOf = async (api: TestApplication, range: HistoryRange) =>
  bodyOf<HistoryBucket[]>(
    await api.admin('get', `/users/user-01/history?range=${range}`).expect(200),
  );

const firstAndLastStart = (buckets: HistoryBucket[]) => [
  buckets.at(0)?.start,
  buckets.at(-1)?.start,
];

/**
 * The buckets a history should return at the current time: `count` buckets
 * of `widthMs` ending with the current one, zero except where `counts`, keyed
 * by bucket start, gives `[allowed, denied]`.
 */
function expectedBuckets(
  count: number,
  widthMs: number,
  counts: Record<number, [number, number]>,
): HistoryBucket[] {
  const currentStart = Math.floor(Date.now() / widthMs) * widthMs;
  return Array.from({ length: count }, (_, index) => {
    const start = currentStart - (count - 1 - index) * widthMs;
    const [allowed, denied] = counts[start] ?? [0, 0];
    return { start: new Date(start).toISOString(), allowed, denied };
  });
}

/** user-01 at 89 of 100, user-02 at 90, user-03 at 100 and rejected once. */
async function useQuotas(api: TestApplication) {
  await api.admitInTurn(89);
  await api.admitInTurn(90, 'test-token-02');
  await api.admitInTurn(100, 'test-token-03');
  await api.sample('test-token-03').expect(429);
  await api.admitInTurn(2, 'test-token-04');
  await api.admitInTurn(1, 'test-token-05');
}

describe('dashboard read models', () => {
  const application = useFrozenApplication();

  it('reports no activity before the first request', async () => {
    expect(await analyticsOf(application())).toMatchObject({
      totalUsers: 6,
      activeUsers: 0,
      nearLimitPercent: 0,
      topUsers: [],
    });
  });

  it('agrees on quota and thresholds in snapshot, detail and analytics', async () => {
    const api = application();
    await useQuotas(api);

    const detailRow = (await api.detail()).row;
    const stats = await analyticsOf(api);

    expect(detailRow).toMatchObject({ used: 89, remaining: 11, status: 'OK' });
    expect(await api.snapshotRow('user-01')).toEqual(detailRow);
    expect(await api.snapshotRow('user-02')).toMatchObject({
      used: 90,
      remaining: 10,
      status: 'Warning',
    });
    expect(await api.snapshotRow('user-03')).toMatchObject({
      used: 100,
      remaining: 0,
      status: 'Exceeded',
    });
    expect(stats).toMatchObject({
      totalUsers: 6,
      activeUsers: 5,
      nearLimitPercent: 40,
      denied429Today: 1,
      day: '2099-01-01',
    });
    expect(stats.topUsers).toEqual([
      { userId: 'user-03', used: 100, total: 100 },
      { userId: 'user-02', used: 90, total: 100 },
      { userId: 'user-01', used: 89, total: 100 },
      { userId: 'user-04', used: 2, total: 100 },
      { userId: 'user-05', used: 1, total: 100 },
    ]);
  });

  it('counts users at each status as the snapshot rows of the same moment show them', async () => {
    const api = application();
    await useQuotas(api);

    const { statusCounts, totalUsers } = await analyticsOf(api);
    const rows = await api.snapshot();

    expect(statusCounts).toEqual({ OK: 4, Warning: 1, Exceeded: 1 });
    const statuses: Status[] = ['OK', 'Warning', 'Exceeded'];
    for (const status of statuses) {
      expect(statusCounts[status]).toBe(
        rows.filter((row) => row.status === status).length,
      );
    }
    expect(rows).toHaveLength(totalUsers);
  });

  it('turns a user to Warning at 90 of 100 in the header, detail and analytics', async () => {
    const api = application();
    await useQuotas(api);

    const crossing = await api.sample().expect(200);

    expect(crossing.headers['x-count']).toBe('10');
    expect((await api.detail()).row).toMatchObject({
      used: 90,
      remaining: 10,
      status: 'Warning',
    });
    expect((await analyticsOf(api)).nearLimitPercent).toBe(60);
  });

  it('ranks the top five users by usage, equal usage by ID', async () => {
    const api = application();
    await api.admitInTurn(3, 'test-token-03');
    await api.admitInTurn(2, 'test-token-02');
    await api.admitInTurn(2, 'test-token-04');
    for (const token of ['test-token-01', 'test-token-05', 'test-token-06'])
      await api.admitInTurn(1, token);

    const { topUsers } = await analyticsOf(api);

    expect(topUsers.map((user) => user.used)).toEqual([3, 2, 2, 1, 1]);
    // Plain string order of the ID, where `U` precedes `u`.
    expect(topUsers.map((user) => user.userId)).toEqual([
      'user-03',
      'user-02',
      'user-04',
      'User_06-TEST',
      'user-01',
    ]);
  });

  it('includes the previous hour and zero-filled buckets in the hour and day histories', async () => {
    const api = application();
    await api.admin('put', '/users/user-01/limit', { limit: 1 }).expect(200);

    await api.sample().expect(200);
    vi.setSystemTime(TEST_NOW + 2 * MINUTE_MS);
    await api.sample().expect(429);
    vi.setSystemTime(NEXT_HOUR + MINUTE_MS);
    await api.sample().expect(200);
    await api.sample().expect(429);

    const hour = await historyOf(api, 'hour');
    const day = await historyOf(api, 'day');

    expect(hour).toEqual(
      expectedBuckets(MINUTES_PER_HOUR, MINUTE_MS, {
        [TEST_NOW]: [1, 0],
        [TEST_NOW + 2 * MINUTE_MS]: [0, 1],
        [NEXT_HOUR + MINUTE_MS]: [1, 1],
      }),
    );
    expect(firstAndLastStart(hour)).toEqual([
      '2099-01-01T10:02:00.000Z',
      '2099-01-01T11:01:00.000Z',
    ]);
    expect(day).toEqual(
      expectedBuckets(HOURS_PER_DAY, HOUR_MS, {
        [NEXT_HOUR - HOUR_MS]: [1, 1],
        [NEXT_HOUR]: [1, 1],
      }),
    );
    expect(firstAndLastStart(day)).toEqual([
      '2098-12-31T12:00:00.000Z',
      '2099-01-01T11:00:00.000Z',
    ]);
  });

  it('keeps the 100 most recent requests after 150 attempts', async () => {
    const api = application();

    await api.admitInTurn(100);
    for (let attempt = 0; attempt < 50; attempt++)
      await api.sample().expect(429);
    const recent = (await api.detail()).recentRequests;

    // The stored list itself: a read of at most 100 cannot show the trim.
    expect(await api.redis.lLen('rl:hist:user-01')).toBe(100);
    expect(recent).toHaveLength(100);
    expect(new Set(recent.map((entry) => entry.id)).size).toBe(100);
    const denied = recent.filter((entry) => entry.outcome === 'denied');
    expect(denied).toHaveLength(50);
  });
});
