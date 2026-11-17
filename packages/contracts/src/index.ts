/**
 * Shared contract between the API and the dashboard.
 *
 * Types only. Import with `import type`; this file must never contain a
 * runtime value, so neither application depends on the other's build. The
 * routes and behavior are described in the specifications under docs/specs/.
 *
 * All timestamps are ISO 8601 strings in UTC.
 */

// ---------------------------------------------------------------- the row

/** Status shown in the table. Computed by the server, never by the browser. */
export type Status = 'OK' | 'Warning' | 'Exceeded';

/**
 * One user's state in the current window. This is the table row, the body
 * returned by every admin action and the payload of every socket event.
 */
export interface UserRow {
  userId: string;
  /** Requests counted in the current window, including bypassed ones. */
  used: number;
  /** Base limit: the default 100 or the custom limit. */
  limit: number;
  /** Extra requests granted for the current window only. */
  extra: number;
  /** `limit + extra`: the "Total" in "Remaining / Total". */
  total: number;
  /** `max(0, total - used)`. */
  remaining: number;
  status: Status;
  /** Next UTC hour boundary. The same for every user. */
  resetAt: string;
  /** Last attempt, admitted or rejected. Null if the user never called. */
  lastRequestAt: string | null;
  /** The later of the window start and the last manual reset. */
  lastResetAt: string;
  /** End of the throttling suspension, or null when not suspended. */
  suspendedUntil: string | null;
  /**
   * Grows by one with every change to this user and never goes back. A new
   * hour resets usage without changing it, so the browser orders two rows
   * of one user by `resetAt` first and `version` second.
   */
  version: number;
}

// ------------------------------------------------------------ user detail

/** `bypassed`: admitted over the cap because throttling was suspended. */
export type RequestOutcome = 'allowed' | 'denied' | 'bypassed';

/** One attempt, as kept in the capped recent-requests list. */
export interface RequestRecord {
  /** Unique per attempt. Usable as a list key. */
  id: string;
  at: string;
  outcome: RequestOutcome;
  /** Remaining requests right after this attempt. */
  remaining: number;
}

/** Body of `GET /api/admin/users/:userId`. */
export interface UserDetail {
  row: UserRow;
  /** Sorted by `at`, newest first; at most 100 from the last 24 hours. */
  recentRequests: RequestRecord[];
}

export type HistoryRange = 'hour' | 'day';

/**
 * One bar of the history chart: a minute (`range=hour`) or an hour
 * (`range=day`). The server sends every bucket of the range, zero-filled.
 */
export interface HistoryBucket {
  /** Start of the bucket. */
  start: string;
  /** Admitted requests, including bypassed ones. */
  allowed: number;
  denied: number;
}

// -------------------------------------------------------------- analytics

export interface TopUser {
  userId: string;
  used: number;
  total: number;
}

/** Body of `GET /api/admin/analytics`. */
export interface Analytics {
  /** All seeded users. */
  totalUsers: number;
  /** Users with at least one counted request in the current window. */
  activeUsers: number;
  /**
   * Share of active users at 90% or more of their cap, Exceeded included,
   * as a whole number from 0 to 100. 0 when nobody is active.
   */
  nearLimitPercent: number;
  /** 429 responses on `day`. */
  denied429Today: number;
  /** The UTC date `denied429Today` refers to, as YYYY-MM-DD. */
  day: string;
  /** Up to five users with the highest `used`; equal users in no defined order. */
  topUsers: TopUser[];
}

// ---------------------------------------------------------- socket events

/** What caused a `rate:update`. */
export type UpdateCause =
  | 'request'
  | 'reset'
  | 'limit'
  | 'suspend'
  | 'unsuspend'
  | 'extra';

/** Payload of `rate:update`. */
export interface RateUpdateEvent {
  cause: UpdateCause;
  at: string;
  row: UserRow;
  /** The admitted request when `cause` is `request`, otherwise null. */
  request: RequestRecord | null;
}

/** Payload of `rate:limit_exceeded`: the first rejection in a window. */
export interface RateLimitExceededEvent {
  at: string;
  row: UserRow;
  /** When the user can try again: the window's reset time. */
  retryAt: string;
  /** The rejected request. */
  request: RequestRecord;
}

/** Event map for a typed Socket.IO server and client. */
export interface ServerToClientEvents {
  'rate:update': (event: RateUpdateEvent) => void;
  'rate:limit_exceeded': (event: RateLimitExceededEvent) => void;
}

/** The dashboard sends nothing over the socket. */
export type ClientToServerEvents = Record<string, never>;

/** Sent in the Socket.IO handshake as `auth`. */
export interface SocketAuth {
  token: string;
}

// --------------------------------------------------------- request bodies

/** `PUT /api/admin/users/:userId/limit`. Integer, 1 to 10000. */
export interface SetLimitBody {
  limit: number;
}

/** `POST /api/admin/users/:userId/suspension`. Integer, 1 to 1440. */
export interface SuspendBody {
  minutes: number;
}

/** `POST /api/admin/users/:userId/extra`. Integer, 1 to 10000. */
export interface ExtraBody {
  amount: number;
}

// -------------------------------------------------------------- responses

/** Body of `GET /api/sample` on success. */
export interface SampleResponse {
  ok: true;
  userId: string;
  at: string;
}

/** Body of every error response. */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}

/** Body of a 429. `Retry-After` carries `retryAfterSeconds` as a header. */
export interface RateLimitedError extends ApiError {
  statusCode: 429;
  retryAt: string;
  retryAfterSeconds: number;
}
