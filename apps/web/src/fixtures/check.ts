/**
 * Checks that the fixture numbers agree with the quota rules. It restates
 * those rules on purpose: it is the independent answer the hand-written
 * numbers are compared with, and the application never uses it.
 */
import type { Status, UserRow } from '@app/contracts';
import {
  analytics,
  details,
  historyDay,
  historyHour,
  limitExceeded,
  requestUpdate,
  resetUpdate,
  users,
  RESET_AT,
  WINDOW_START,
} from './index.ts';
import { HOUR_MS, MINUTE_MS } from '../lib/time.ts';

let checks = 0;
const check = (condition: boolean, message: string): void => {
  checks += 1;
  if (!condition) throw new Error(`fixture check failed: ${message}`);
};

// Warning from 90% of the total, compared in integers.
function expectedStatus(used: number, total: number): Status {
  if (used >= total) return 'Exceeded';
  if (used * 10 >= total * 9) return 'Warning';
  return 'OK';
}

const checkRow = (row: UserRow, label: string): void => {
  check(row.total === row.limit + row.extra, `${label}: total`);
  check(
    row.remaining === Math.max(0, row.total - row.used),
    `${label}: remaining`,
  );
  check(row.status === expectedStatus(row.used, row.total), `${label}: status`);
  check(row.resetAt === RESET_AT, `${label}: resetAt`);
  check(
    row.lastResetAt >= WINDOW_START,
    `${label}: lastResetAt before the window`,
  );
  check(
    row.used === 0 || row.lastRequestAt !== null,
    `${label}: used without a last request`,
  );
  check(Number.isInteger(row.version) && row.version >= 0, `${label}: version`);
};

// Every row, including the ones inside events.
users.forEach((row) => checkRow(row, row.userId));
[requestUpdate.row, resetUpdate.row, limitExceeded.row].forEach((row) =>
  checkRow(row, `event row ${row.userId}`),
);

// The table is sorted and has no duplicates.
const ids = users.map((row) => row.userId);
check(
  ids.join() === [...new Set(ids)].sort().join(),
  'users sorted by unique ID',
);

// Each status and each special state appears at least once.
(['OK', 'Warning', 'Exceeded'] as const).forEach((status) =>
  check(
    users.some((row) => row.status === status),
    `a row with status ${status}`,
  ),
);
check(
  users.some((row) => row.suspendedUntil !== null),
  'a suspended row',
);
check(
  users.some((row) => row.extra > 0),
  'a row with an extra grant',
);
check(
  users.some((row) => row.limit !== 100),
  'a row with a custom limit',
);
check(
  users.some((row) => row.lastRequestAt === null),
  'a row that never called',
);
check(
  users.some((row) => row.used > row.total),
  'a row with usage above the cap',
);

// Events must be newer than the snapshot row they replace.
const snapshotVersion = (userId: string): number =>
  users.find((row) => row.userId === userId)?.version ?? -1;
[requestUpdate.row, resetUpdate.row, limitExceeded.row].forEach((row) =>
  check(
    row.version > snapshotVersion(row.userId),
    `event for ${row.userId} is newer`,
  ),
);

// Analytics agree with the rows.
const active = users.filter((row) => row.used > 0);
const near = active.filter((row) => row.status !== 'OK');
check(analytics.totalUsers === users.length, 'analytics: totalUsers');
check(analytics.activeUsers === active.length, 'analytics: activeUsers');
check(
  analytics.nearLimitPercent ===
    Math.round((near.length / active.length) * 100),
  'analytics: nearLimitPercent',
);
// Ranked by usage only, like the API; equal users keep their order.
const top = [...users]
  .sort((a, b) => b.used - a.used)
  .slice(0, 5)
  .map(({ userId, used, total }) => ({ userId, used, total }));
check(
  JSON.stringify(analytics.topUsers) === JSON.stringify(top),
  'analytics: topUsers',
);

// History ranges are complete, ordered and evenly spaced.
const evenlySpaced = (starts: string[], stepMs: number): boolean =>
  starts.every(
    (start, index) =>
      index === 0 ||
      Date.parse(start) - Date.parse(starts[index - 1]!) === stepMs,
  );
check(historyHour.length === 60, 'historyHour: 60 buckets');
check(
  evenlySpaced(
    historyHour.map((bucket) => bucket.start),
    MINUTE_MS,
  ),
  'historyHour: spacing',
);
check(historyDay.length === 24, 'historyDay: 24 buckets');
check(
  evenlySpaced(
    historyDay.map((bucket) => bucket.start),
    HOUR_MS,
  ),
  'historyDay: spacing',
);

// Details point at table rows; recent lists are newest first, unique ids.
Object.entries(details).forEach(([userId, detail]) => {
  check(detail.row.userId === userId, `detail ${userId}: row`);
  const times = detail.recentRequests.map((request) => request.at);
  check(
    times.join() === [...times].sort().reverse().join(),
    `detail ${userId}: newest first`,
  );
  const requestIds = detail.recentRequests.map((request) => request.id);
  check(
    new Set(requestIds).size === requestIds.length,
    `detail ${userId}: unique ids`,
  );
});

console.log(`fixtures consistent: ${checks} checks passed`);
