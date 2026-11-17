import type {
  Analytics,
  HistoryBucket,
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const optionalTime = (value: unknown) => value === null || timestamp(value);

// Validate shape at the I/O boundary; never derive quota or status here.
export function isUserRow(value: unknown): value is UserRow {
  return (
    object(value) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    ['used', 'limit', 'extra', 'total', 'remaining', 'version'].every((key) =>
      count(value[key]),
    ) &&
    (value.status === 'OK' ||
      value.status === 'Warning' ||
      value.status === 'Exceeded') &&
    timestamp(value.resetAt) &&
    timestamp(value.lastResetAt) &&
    optionalTime(value.lastRequestAt) &&
    optionalTime(value.suspendedUntil)
  );
}

export const isUsers = (value: unknown): value is UserRow[] =>
  Array.isArray(value) && value.every(isUserRow);

export function isRequestRecord(value: unknown): value is RequestRecord {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    timestamp(value.at) &&
    (value.outcome === 'allowed' ||
      value.outcome === 'denied' ||
      value.outcome === 'bypassed') &&
    count(value.remaining)
  );
}

export function isDetail(value: unknown): value is UserDetail {
  return (
    object(value) &&
    isUserRow(value.row) &&
    Array.isArray(value.recentRequests) &&
    value.recentRequests.every(isRequestRecord)
  );
}

export function isHistory(value: unknown): value is HistoryBucket[] {
  return (
    Array.isArray(value) &&
    value.every(
      (bucket: unknown) =>
        object(bucket) &&
        timestamp(bucket.start) &&
        count(bucket.allowed) &&
        count(bucket.denied),
    )
  );
}

export function isAnalytics(value: unknown): value is Analytics {
  return (
    object(value) &&
    count(value.totalUsers) &&
    count(value.activeUsers) &&
    count(value.nearLimitPercent) &&
    value.nearLimitPercent <= 100 &&
    count(value.denied429Today) &&
    typeof value.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.day) &&
    Array.isArray(value.topUsers) &&
    value.topUsers.every(
      (user: unknown) =>
        object(user) &&
        typeof user.userId === 'string' &&
        count(user.used) &&
        count(user.total),
    )
  );
}

export function isRateUpdate(value: unknown): value is RateUpdateEvent {
  return (
    object(value) &&
    isUserRow(value.row) &&
    timestamp(value.at) &&
    typeof value.cause === 'string' &&
    ['request', 'reset', 'limit', 'suspend', 'unsuspend', 'extra'].includes(
      value.cause,
    ) &&
    (value.request === null || isRequestRecord(value.request))
  );
}

export function isLimitExceeded(
  value: unknown,
): value is RateLimitExceededEvent {
  return (
    object(value) &&
    isUserRow(value.row) &&
    timestamp(value.at) &&
    timestamp(value.retryAt) &&
    isRequestRecord(value.request)
  );
}
