import type { Analytics, TopUser, UserRow } from '@app/contracts';
import { utcDay } from '../rate-limit/keys.js';

const TOP_USER_COUNT = 5;

export function analytics(
  rows: UserRow[],
  denied429Today: number,
  now: number,
): Analytics {
  const activeRows = rows.filter((row) => row.used > 0);
  const totalUsers = rows.length;
  const activeUsers = activeRows.length;
  const nearLimitCount = activeRows.filter((row) => row.status !== 'OK').length;
  const nearLimitPercent = percentOf(nearLimitCount, activeUsers);
  const topUsers = topUsersByUsage(activeRows);
  const day = utcDay(now);

  return {
    totalUsers,
    activeUsers,
    nearLimitPercent,
    denied429Today,
    day,
    topUsers,
  };
}

function topUsersByUsage(rows: UserRow[]): TopUser[] {
  return rows
    .toSorted((a, b) => b.used - a.used)
    .slice(0, TOP_USER_COUNT)
    .map(({ userId, used, total }) => ({ userId, used, total }));
}

function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part * 100) / whole);
}
