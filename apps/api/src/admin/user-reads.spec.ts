import type { UserRow, UsersQuery } from '@app/contracts';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { RateLimitStore } from '../rate-limit/rate-limit.store.js';
import { buildRow } from '../rate-limit/row.js';
import { UserRegistry } from '../users/user-registry.js';
import { closestOf, UserReads } from './user-reads.js';

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
  sort: 'id',
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

  describe('sorted closest to the limit', () => {
    // Each ID with its used and total, in the batches the registry yields.
    const shares: Record<string, [number, number]> = {
      'user-01': [99, 100],
      'user-02': [30, 10],
      'user-03': [104, 110],
      'user-04': [90, 100],
      'user-05': [100, 100],
      'user-06': [130, 100],
      'user-07': [18, 20],
    };

    function readShares(entries: Record<string, [number, number]>) {
      store.snapshot.mockImplementation(async (userIds) =>
        userIds.map((userId) => {
          const [used, total] = entries[userId];
          return buildRow(userId, [used, `${total}`, null, null, {}], now);
        }),
      );
    }

    beforeEach(() => {
      readShares(shares);
      registryIn(
        ['user-01', 'user-02', 'user-03', 'user-04'],
        ['user-05', 'user-06', 'user-07'],
      );
    });

    it('orders every batch by the share of the cap used, not by the count, equal shares by ID', async () => {
      const page = await reads.page({ ...anyQuery, sort: 'closest' }, now);

      expect(idsOf(page.rows)).toEqual([
        'user-02',
        'user-06',
        'user-05',
        'user-01',
        'user-03',
        'user-04',
        'user-07',
      ]);
      expect(page.total).toBe(7);
      expect(registry.page).not.toHaveBeenCalled();
    });

    it('keeps equal shares of different caps in ID order', async () => {
      readShares({ 'user-01': [33, 99], 'user-02': [1, 3] });
      registryIn(['user-01'], ['user-02']);

      const page = await reads.page({ ...anyQuery, sort: 'closest' }, now);

      expect(idsOf(page.rows)).toEqual(['user-01', 'user-02']);
    });

    it('cuts the page after the filter and the order, and counts every match', async () => {
      const query: UsersQuery = {
        ...anyQuery,
        sort: 'closest',
        status: 'Warning',
        pageSize: 2,
        page: 2,
      };
      readShares({
        'user-01': [90, 100],
        'user-02': [95, 100],
        'user-03': [99, 100],
        'user-04': [18, 20],
        'user-05': [5, 100],
        'user-06': [130, 100],
        'user-07': [0, 100],
      });

      const page = await reads.page(query, now);

      // Warning by share: user-03, user-02, then user-01 and user-04 by ID.
      expect(idsOf(page.rows)).toEqual(['user-01', 'user-04']);
      expect(page.total).toBe(4);
    });

    it('puts the closest rows of a later batch before worse ones read earlier', async () => {
      const query: UsersQuery = { ...anyQuery, sort: 'closest', pageSize: 2 };

      const page = await reads.page(query, now);

      // user-06 and user-05 come in the second batch.
      expect(idsOf(page.rows)).toEqual(['user-02', 'user-06']);
      expect(page.total).toBe(7);
    });

    it('cuts a page that spans two batches, and counts every match', async () => {
      const query: UsersQuery = {
        ...anyQuery,
        sort: 'closest',
        pageSize: 2,
        page: 2,
      };

      const page = await reads.page(query, now);

      // user-05 from the second batch, user-01 from the first.
      expect(idsOf(page.rows)).toEqual(['user-05', 'user-01']);
      expect(page.total).toBe(7);
    });

    it('answers a page past the end with no rows and the count of matches', async () => {
      const query: UsersQuery = {
        ...anyQuery,
        sort: 'closest',
        pageSize: 5,
        page: 3,
      };

      const page = await reads.page(query, now);

      expect(page.rows).toEqual([]);
      expect(page.total).toBe(7);
    });

    it('keeps no more rows than the depth of the page between batches', () => {
      const row = (userId: string) => {
        const [used, total] = shares[userId];
        return buildRow(userId, [used, `${total}`, null, null, {}], now);
      };
      const kept = [row('user-05'), row('user-04')];
      const batch = [row('user-07'), row('user-02'), row('user-01')];

      expect(idsOf(closestOf(kept, batch, 3))).toEqual([
        'user-02',
        'user-05',
        'user-01',
      ]);
    });
  });

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
