import type { UserRow } from '@app/contracts';

/** The filter value that lets every row through. */
export const ANY = 'any';

const matchesSearch = (row: UserRow, search: string) =>
  row.userId.toLowerCase().includes(search.toLowerCase());

const matchesStatus = (row: UserRow, status: string) =>
  status === ANY || row.status === status;

function wasActiveWithin(row: UserRow, periodMs: string, now: number) {
  if (periodMs === ANY) return true;
  if (row.lastRequestAt === null) return false;
  return Date.parse(row.lastRequestAt) >= now - Number(periodMs);
}

function byUserId(a: UserRow, b: UserRow): number {
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

/** The rows that pass all three filters, in user ID order. */
export function filterUsers(
  rows: UserRow[],
  search: string,
  status: string,
  activePeriodMs: string,
  now: number,
): UserRow[] {
  return rows
    .filter(
      (row) =>
        matchesSearch(row, search) &&
        matchesStatus(row, status) &&
        wasActiveWithin(row, activePeriodMs, now),
    )
    .sort(byUserId);
}
