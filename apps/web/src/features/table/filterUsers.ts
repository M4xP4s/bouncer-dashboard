import type { UserRow } from '@app/contracts';

export function filterUsers(
  rows: UserRow[],
  search: string,
  status: string,
  active: string,
  now: number,
) {
  return rows
    .filter(
      (row) =>
        row.userId.toLowerCase().includes(search.toLowerCase()) &&
        (status === 'any' || row.status === status) &&
        (active === 'any' ||
          (row.lastRequestAt !== null &&
            Date.parse(row.lastRequestAt) >= now - Number(active))),
    )
    .sort((a, b) => {
      if (a.userId === b.userId) return 0;
      return a.userId < b.userId ? -1 : 1;
    });
}
