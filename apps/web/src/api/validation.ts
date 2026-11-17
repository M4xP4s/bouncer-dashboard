import type {
  Analytics,
  HistoryBucket,
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestOutcome,
  RequestRecord,
  Status,
  TopUser,
  UpdateCause,
  UserDetail,
  UserRow,
} from '@app/contracts';

// Shape checks at the I/O boundary. They never derive quota or status.

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERCENT = 100;

// A record, so a member added to a union does not compile until it is
// listed here.
const members = <T extends string>(all: Record<T, true>): readonly string[] =>
  Object.keys(all);

const STATUSES = members<Status>({ OK: true, Warning: true, Exceeded: true });
const OUTCOMES = members<RequestOutcome>({
  allowed: true,
  denied: true,
  bypassed: true,
});
const CAUSES = members<UpdateCause>({
  request: true,
  reset: true,
  limit: true,
  suspend: true,
  unsuspend: true,
  extra: true,
});
const ROW_COUNTS = [
  'used',
  'limit',
  'extra',
  'total',
  'remaining',
  'version',
] satisfies (keyof UserRow)[];

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isOneOf = (allowed: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && allowed.includes(value);

// The pattern alone accepts month 13; Date.parse rejects it.
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_TIMESTAMP.test(value) &&
  Number.isFinite(Date.parse(value));

const isOptionalTimestamp = (value: unknown) =>
  value === null || isTimestamp(value);

export function isUserRow(value: unknown): value is UserRow {
  return (
    isObject(value) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    ROW_COUNTS.every((field) => isCount(value[field])) &&
    isOneOf(STATUSES, value.status) &&
    isTimestamp(value.resetAt) &&
    isTimestamp(value.lastResetAt) &&
    isOptionalTimestamp(value.lastRequestAt) &&
    isOptionalTimestamp(value.suspendedUntil)
  );
}

export const isUsers = (value: unknown): value is UserRow[] =>
  Array.isArray(value) && value.every(isUserRow);

export function isRequestRecord(value: unknown): value is RequestRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    isTimestamp(value.at) &&
    isOneOf(OUTCOMES, value.outcome) &&
    isCount(value.remaining)
  );
}

export function isDetail(value: unknown): value is UserDetail {
  return (
    isObject(value) &&
    isUserRow(value.row) &&
    Array.isArray(value.recentRequests) &&
    value.recentRequests.every(isRequestRecord)
  );
}

function isHistoryBucket(value: unknown): value is HistoryBucket {
  return (
    isObject(value) &&
    isTimestamp(value.start) &&
    isCount(value.allowed) &&
    isCount(value.denied)
  );
}

export const isHistory = (value: unknown): value is HistoryBucket[] =>
  Array.isArray(value) && value.every(isHistoryBucket);

function isTopUser(value: unknown): value is TopUser {
  return (
    isObject(value) &&
    typeof value.userId === 'string' &&
    isCount(value.used) &&
    isCount(value.total)
  );
}

export function isAnalytics(value: unknown): value is Analytics {
  return (
    isObject(value) &&
    isCount(value.totalUsers) &&
    isCount(value.activeUsers) &&
    isCount(value.nearLimitPercent) &&
    value.nearLimitPercent <= MAX_PERCENT &&
    isCount(value.denied429Today) &&
    typeof value.day === 'string' &&
    ISO_DAY.test(value.day) &&
    Array.isArray(value.topUsers) &&
    value.topUsers.every(isTopUser)
  );
}

export function isRateUpdate(value: unknown): value is RateUpdateEvent {
  return (
    isObject(value) &&
    isUserRow(value.row) &&
    isTimestamp(value.at) &&
    isOneOf(CAUSES, value.cause) &&
    (value.request === null || isRequestRecord(value.request))
  );
}

export function isLimitExceeded(
  value: unknown,
): value is RateLimitExceededEvent {
  return (
    isObject(value) &&
    isUserRow(value.row) &&
    isTimestamp(value.at) &&
    isTimestamp(value.retryAt) &&
    isRequestRecord(value.request)
  );
}
