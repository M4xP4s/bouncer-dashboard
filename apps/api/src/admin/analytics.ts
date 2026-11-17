import type { Analytics, UserRow } from '@app/contracts';
import { utcDay } from '../rate-limit/keys.js';

const TOP_USER_COUNT = 5;
const PERCENT_SCALE = 100;
export function analytics(
  rows: UserRow[],
  denied429Today: number,
  now: number,
): Analytics {
  const active = rows.filter((row) => row.used > 0);
  const near = active.filter((row) => row.status !== 'OK').length;
  const topUsers = active
    .toSorted((a, b) => b.used - a.used)
    .slice(0, TOP_USER_COUNT)
    .map(({ userId, used, total }) => ({ userId, used, total }));
  const activeUsers = active.length;
  const nearLimitPercent = activeUsers
    ? Math.round((near * PERCENT_SCALE) / activeUsers)
    : 0;
  const day = utcDay(now);
  return {
    totalUsers: rows.length,
    activeUsers,
    nearLimitPercent,
    denied429Today,
    day,
    topUsers,
  };
}
