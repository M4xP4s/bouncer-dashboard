import type {
  ActivePeriod,
  UserRow,
  UsersPage,
  UsersQuery,
} from '@app/contracts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.ts';

const ACTIVE_PERIOD_MS: Record<ActivePeriod, number> = {
  '5m': 5 * MINUTE_MS,
  '1h': HOUR_MS,
  '24h': DAY_MS,
};

const matchesSearch = (row: UserRow, search: string) =>
  row.userId.toLowerCase().includes(search.toLowerCase());

const matchesStatus = (row: UserRow, status: UsersQuery['status']) =>
  status === 'any' || row.status === status;

function wasActiveWithin(
  row: UserRow,
  active: UsersQuery['active'],
  now: number,
) {
  if (active === 'any') return true;
  if (row.lastRequestAt === null) return false;
  return Date.parse(row.lastRequestAt) >= now - ACTIVE_PERIOD_MS[active];
}

function byUserId(a: UserRow, b: UserRow): number {
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

/** The rows that pass all three filters, in user ID order. */
function filterUsers(
  rows: UserRow[],
  query: UsersQuery,
  now: number,
): UserRow[] {
  return rows
    .filter(
      (row) =>
        matchesSearch(row, query.search) &&
        matchesStatus(row, query.status) &&
        wasActiveWithin(row, query.active, now),
    )
    .sort(byUserId);
}

/** The page the admin API answers: filters first, then the cut. */
export function usersPage(
  rows: UserRow[],
  query: UsersQuery,
  now: number,
): UsersPage {
  const matches = filterUsers(rows, query, now);
  const offset = (query.page - 1) * query.pageSize;
  const readAt = new Date(now).toISOString();
  return {
    rows: matches.slice(offset, offset + query.pageSize),
    total: matches.length,
    page: query.page,
    pageSize: query.pageSize,
    startedAt: readAt,
    completedAt: readAt,
  };
}
