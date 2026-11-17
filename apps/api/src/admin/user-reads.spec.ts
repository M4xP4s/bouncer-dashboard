import type { UserRow, UsersQuery } from '@app/contracts';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { RateLimitStore } from '../rate-limit/rate-limit.store.js';
import { buildRow } from '../rate-limit/row.js';
import { UserRegistry } from '../users/user-registry.js';
import { UserReads } from './user-reads.js';

const now = Date.parse('2099-01-01T10:30:00.000Z');
const registry = mockDeep<UserRegistry>();
const store = mockDeep<RateLimitStore>();
const reads = new UserReads(registry, store);

const anyQuery: UsersQuery = {
  page: 1,
  pageSize: 50,
  search: '',
  status: 'any',
  active: 'any',
};

// used 0 is OK, 90 is Warning, 101 is Exceeded with the default cap of 100.
const usageById: Record<string, number> = {
  'user-01': 90,
  'user-02': 0,
  'User-03': 90,
  'user-04': 101,
  'user-05': 90,
};
const lastRequestById: Record<string, number> = {
  'user-01': now - 5 * 60_000,
  'User-03': now - 5 * 60_000 - 1,
  'user-04': now - 60 * 60_000,
  'user-05': now - 24 * 60 * 60_000,
};

function rowOf(userId: string): UserRow {
  const user: Record<string, string> = {};
  if (userId in lastRequestById) {
    user.lastRequestAt = `${lastRequestById[userId]}`;
  }
  return buildRow(userId, [usageById[userId], null, null, null, user], now);
}

function registryIn(...batches: string[][]) {
  registry.batches.mockImplementation(async function* () {
    yield* batches;
  });
}

const idsOf = (rows: UserRow[]) => rows.map((row) => row.userId);

describe('UserReads', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: now + 250 });
    mockReset(registry);
    mockReset(store);
    store.snapshot.mockImplementation(async (userIds) => userIds.map(rowOf));
    registryIn(['User-03', 'user-01', 'user-02'], ['user-04', 'user-05']);
  });
  afterEach(() => vi.useRealTimers());

  it('reads only the IDs and rows of an unfiltered page', async () => {
    registry.page.mockResolvedValue({ total: 5, userIds: ['user-04'] });

    const page = await reads.page({ ...anyQuery, page: 4, pageSize: 1 }, now);

    expect(registry.page).toHaveBeenCalledExactlyOnceWith(3, 1);
    expect(store.snapshot).toHaveBeenCalledExactlyOnceWith(['user-04'], now);
    expect(registry.batches).not.toHaveBeenCalled();
    expect(page).toEqual({
      rows: [rowOf('user-04')],
      total: 5,
      page: 4,
      pageSize: 1,
      startedAt: '2099-01-01T10:30:00.000Z',
      completedAt: '2099-01-01T10:30:00.250Z',
    });
  });

  it('answers an unfiltered page past the end with no rows and no row read', async () => {
    registry.page.mockResolvedValue({ total: 5, userIds: [] });

    const page = await reads.page({ ...anyQuery, page: 9 }, now);

    expect(page).toMatchObject({ rows: [], total: 5 });
    expect(store.snapshot).not.toHaveBeenCalled();
  });

  it('filters every batch before it cuts the page, and counts every match', async () => {
    const query: UsersQuery = { ...anyQuery, status: 'Warning', pageSize: 2 };

    const first = await reads.page(query, now);
    const second = await reads.page({ ...query, page: 2 }, now);
    const pastEnd = await reads.page({ ...query, page: 3 }, now);

    expect(idsOf(first.rows)).toEqual(['User-03', 'user-01']);
    expect(idsOf(second.rows)).toEqual(['user-05']);
    expect(pastEnd.rows).toEqual([]);
    expect([first.total, second.total, pastEnd.total]).toEqual([3, 3, 3]);
    expect(registry.page).not.toHaveBeenCalled();
  });

  it('matches the search as a case-insensitive substring of the ID', async () => {
    const page = await reads.page({ ...anyQuery, search: 'USER-0' }, now);

    expect(idsOf(page.rows)).toEqual([
      'User-03',
      'user-01',
      'user-02',
      'user-04',
      'user-05',
    ]);
    const none = await reads.page({ ...anyQuery, search: 'r-3' }, now);
    expect(none.total).toBe(0);
  });

  it.each([
    { active: '5m', expected: ['user-01'] },
    { active: '1h', expected: ['User-03', 'user-01', 'user-04'] },
    { active: '24h', expected: ['User-03', 'user-01', 'user-04', 'user-05'] },
  ] as const)(
    'keeps last requests at or after the start minus $active',
    async ({ active, expected }) => {
      const page = await reads.page({ ...anyQuery, active }, now);

      // user-02 never called, so it matches no period.
      expect(idsOf(page.rows)).toEqual(expected);
      expect(page.total).toBe(expected.length);
    },
  );

  it('adds up analytics over every batch, read at the start time', async () => {
    store.denied429.mockResolvedValue(4);

    const analytics = await reads.analytics(now);

    expect(store.snapshot).toHaveBeenNthCalledWith(
      1,
      ['User-03', 'user-01', 'user-02'],
      now,
    );
    expect(store.snapshot).toHaveBeenNthCalledWith(
      2,
      ['user-04', 'user-05'],
      now,
    );
    expect(analytics).toMatchObject({
      totalUsers: 5,
      activeUsers: 4,
      nearLimitPercent: 100,
      denied429Today: 4,
      startedAt: '2099-01-01T10:30:00.000Z',
      completedAt: '2099-01-01T10:30:00.250Z',
    });
    expect(analytics.topUsers.map((user) => user.userId)).toEqual([
      'user-04',
      'User-03',
      'user-01',
      'user-05',
    ]);
  });
});
