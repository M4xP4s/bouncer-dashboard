/**
 * Example payloads, one for every state the dashboard has to show. Fixture
 * mode serves them and the tests read them.
 *
 * Everything is pinned to one moment, 10:42:00 UTC on 2026-11-16, inside
 * the window 10:00 to 11:00. `check.ts` in this folder verifies that the
 * numbers agree with each other.
 */
import type {
  Analytics,
  HistoryBucket,
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { HOUR_MS, MINUTE_MS } from '../lib/time.ts';

/** The moment all fixtures describe. */
export const NOW = '2026-11-16T10:42:00.000Z';
export const WINDOW_START = '2026-11-16T10:00:00.000Z';
export const RESET_AT = '2026-11-16T11:00:00.000Z';

/** Body of `GET /api/admin/users`: sorted by user ID. */
export const users: UserRow[] = [
  // Light use.
  {
    userId: 'user-01',
    used: 12,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 88,
    status: 'OK',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:52.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 12,
  },
  // Half used.
  {
    userId: 'user-02',
    used: 50,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 50,
    status: 'OK',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:40:10.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 50,
  },
  // 89%: the last value that is still OK.
  {
    userId: 'user-03',
    used: 89,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 11,
    status: 'OK',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:30.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 89,
  },
  // 90%: the first value that is Warning.
  {
    userId: 'user-04',
    used: 90,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 10,
    status: 'Warning',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:45.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 90,
  },
  // 99%: one request left.
  {
    userId: 'user-05',
    used: 99,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 1,
    status: 'Warning',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:58.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 99,
  },
  // At the limit and still sending: 7 rejected attempts after the 100th.
  {
    userId: 'user-06',
    used: 100,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 0,
    status: 'Exceeded',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:58.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 107,
  },
  // Custom limit of 20.
  {
    userId: 'user-07',
    used: 18,
    limit: 20,
    extra: 0,
    total: 20,
    remaining: 2,
    status: 'Warning',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:39:05.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 19,
  },
  // Extra grant of 10 for this window: total is 110.
  {
    userId: 'user-08',
    used: 104,
    limit: 100,
    extra: 10,
    total: 110,
    remaining: 6,
    status: 'Warning',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:20.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 109,
  },
  // Throttling suspended: admitted past the cap, still counted.
  {
    userId: 'user-09',
    used: 130,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 0,
    status: 'Exceeded',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:41:59.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: '2026-11-16T11:30:00.000Z',
    version: 132,
  },
  // Reset by an admin at 10:30; 5 requests since.
  {
    userId: 'user-10',
    used: 5,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 95,
    status: 'OK',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:36:00.000Z',
    lastResetAt: '2026-11-16T10:30:00.000Z',
    suspendedUntil: null,
    version: 110,
  },
  // Limit lowered to 10 after 30 requests: usage is kept, remaining is 0.
  {
    userId: 'user-11',
    used: 30,
    limit: 10,
    extra: 0,
    total: 10,
    remaining: 0,
    status: 'Exceeded',
    resetAt: RESET_AT,
    lastRequestAt: '2026-11-16T10:20:00.000Z',
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 34,
  },
  // Seeded but has never called.
  {
    userId: 'user-12',
    used: 0,
    limit: 100,
    extra: 0,
    total: 100,
    remaining: 100,
    status: 'OK',
    resetAt: RESET_AT,
    lastRequestAt: null,
    lastResetAt: WINDOW_START,
    suspendedUntil: null,
    version: 0,
  },
];

const row = (userId: string): UserRow => {
  const found = users.find((user) => user.userId === userId);
  if (!found) throw new Error(`no fixture row for ${userId}`);
  return found;
};

/** Newest first: three rejections, then the last admitted requests. */
const user06Recent: RequestRecord[] = [
  {
    id: 'req-06-107',
    at: '2026-11-16T10:41:58.000Z',
    outcome: 'denied',
    remaining: 0,
  },
  {
    id: 'req-06-106',
    at: '2026-11-16T10:41:55.000Z',
    outcome: 'denied',
    remaining: 0,
  },
  {
    id: 'req-06-105',
    at: '2026-11-16T10:41:50.000Z',
    outcome: 'denied',
    remaining: 0,
  },
  {
    id: 'req-06-100',
    at: '2026-11-16T10:41:40.000Z',
    outcome: 'allowed',
    remaining: 0,
  },
  {
    id: 'req-06-099',
    at: '2026-11-16T10:41:30.000Z',
    outcome: 'allowed',
    remaining: 1,
  },
  {
    id: 'req-06-098',
    at: '2026-11-16T10:41:12.000Z',
    outcome: 'allowed',
    remaining: 2,
  },
  {
    id: 'req-06-097',
    at: '2026-11-16T10:40:48.000Z',
    outcome: 'allowed',
    remaining: 3,
  },
  {
    id: 'req-06-096',
    at: '2026-11-16T10:40:31.000Z',
    outcome: 'allowed',
    remaining: 4,
  },
];

/** Body of `GET /api/admin/users/:userId`, keyed by user ID. */
export const details: Record<string, UserDetail> = {
  'user-06': { row: row('user-06'), recentRequests: user06Recent },
  'user-09': {
    row: row('user-09'),
    recentRequests: [
      {
        id: 'req-09-130',
        at: '2026-11-16T10:41:59.000Z',
        outcome: 'bypassed',
        remaining: 0,
      },
      {
        id: 'req-09-129',
        at: '2026-11-16T10:41:57.000Z',
        outcome: 'bypassed',
        remaining: 0,
      },
    ],
  },
  'user-12': { row: row('user-12'), recentRequests: [] },
};

const MINUTE_BUCKETS = 60;
const HOUR_BUCKETS = 24;
const nowMs = Date.parse(NOW);

/**
 * `range=hour` for user-06: one-minute buckets, oldest first, ending with
 * the current minute. Quiet until 10:00, then steady traffic, then
 * rejections in the last two minutes.
 */
export const historyHour: HistoryBucket[] = Array.from(
  { length: MINUTE_BUCKETS },
  (_, index) => {
    const minutesAgo = MINUTE_BUCKETS - 1 - index;
    const start = nowMs - minutesAgo * MINUTE_MS;
    const inWindow = start >= Date.parse(WINDOW_START);
    const lastTwoMinutes = minutesAgo < 2;
    return {
      start: new Date(start).toISOString(),
      allowed: inWindow && !lastTwoMinutes ? 2 + (index % 3) : 0,
      denied: lastTwoMinutes ? 3 + (index % 2) : 0,
    };
  },
);

/** `range=day` for user-06: one-hour buckets ending with this hour. */
export const historyDay: HistoryBucket[] = Array.from(
  { length: HOUR_BUCKETS },
  (_, index) => {
    const hoursAgo = HOUR_BUCKETS - 1 - index;
    const start = Date.parse(WINDOW_START) - hoursAgo * HOUR_MS;
    const lastTenHours = hoursAgo < 10;
    return {
      start: new Date(start).toISOString(),
      allowed: lastTenHours ? 40 + index * 2 : 0,
      denied: hoursAgo === 0 ? 7 : 0,
    };
  },
);

/** Body of `GET /api/admin/analytics`, consistent with `users`. */
export const analytics: Analytics = {
  startedAt: NOW,
  completedAt: NOW,
  totalUsers: 12,
  activeUsers: 11,
  // 7 of the 11 active users are Warning or Exceeded.
  nearLimitPercent: 64,
  denied429Today: 41,
  day: '2026-11-16',
  topUsers: [
    { userId: 'user-09', used: 130, total: 100 },
    { userId: 'user-08', used: 104, total: 110 },
    { userId: 'user-06', used: 100, total: 100 },
    { userId: 'user-05', used: 99, total: 100 },
    { userId: 'user-04', used: 90, total: 100 },
  ],
};

/** `rate:update` after user-01's next admitted request. */
export const requestUpdate: RateUpdateEvent = {
  cause: 'request',
  at: '2026-11-16T10:42:01.000Z',
  row: {
    ...row('user-01'),
    used: 13,
    remaining: 87,
    lastRequestAt: '2026-11-16T10:42:01.000Z',
    version: 13,
  },
  request: {
    id: 'req-01-013',
    at: '2026-11-16T10:42:01.000Z',
    outcome: 'allowed',
    remaining: 87,
  },
};

/** `rate:update` after an admin resets user-06. */
export const resetUpdate: RateUpdateEvent = {
  cause: 'reset',
  at: '2026-11-16T10:42:02.000Z',
  row: {
    ...row('user-06'),
    used: 0,
    remaining: 100,
    status: 'OK',
    lastResetAt: '2026-11-16T10:42:02.000Z',
    version: 108,
  },
  request: null,
};

/**
 * `rate:limit_exceeded` for user-05: the 100th request was admitted
 * (version 100), then the first rejection of the window (version 101).
 */
export const limitExceeded: RateLimitExceededEvent = {
  at: '2026-11-16T10:42:03.000Z',
  row: {
    ...row('user-05'),
    used: 100,
    remaining: 0,
    status: 'Exceeded',
    lastRequestAt: '2026-11-16T10:42:03.000Z',
    version: 101,
  },
  retryAt: RESET_AT,
  request: {
    id: 'req-05-101',
    at: '2026-11-16T10:42:03.000Z',
    outcome: 'denied',
    remaining: 0,
  },
};
