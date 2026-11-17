import type {
  Analytics,
  ExtraBody,
  HistoryBucket,
  HistoryRange,
  SetLimitBody,
  SuspendBody,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { HttpError, request } from './http.ts';
import {
  isAnalytics,
  isDetail,
  isHistory,
  isUserRow,
  isUsersPage,
} from './validation.ts';

const ADMIN_PATH = '/api/admin';
const UNAUTHORIZED = 401;

export interface ClientOptions {
  token: string;
  /** Ends every request of the session. */
  signal: AbortSignal;
  /** Called when the server refuses the token. */
  onRefused: () => void;
}

/** Every method also accepts a signal that cancels that one request. */
export interface Client {
  users(signal?: AbortSignal): Promise<UserRow[]>;
  detail(userId: string, signal?: AbortSignal): Promise<UserDetail>;
  history(
    userId: string,
    range: HistoryRange,
    signal?: AbortSignal,
  ): Promise<HistoryBucket[]>;
  analytics(signal?: AbortSignal): Promise<Analytics>;
  reset(userId: string, signal?: AbortSignal): Promise<UserRow>;
  setLimit(
    userId: string,
    body: SetLimitBody,
    signal?: AbortSignal,
  ): Promise<UserRow>;
  suspend(
    userId: string,
    body: SuspendBody,
    signal?: AbortSignal,
  ): Promise<UserRow>;
  unsuspend(userId: string, signal?: AbortSignal): Promise<UserRow>;
  addExtra(
    userId: string,
    body: ExtraBody,
    signal?: AbortSignal,
  ): Promise<UserRow>;
}

type Guard<T> = (value: unknown) => value is T;

interface CallInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

const userPath = (userId: string) =>
  `${ADMIN_PATH}/users/${encodeURIComponent(userId)}`;

export function createClient(options: ClientOptions): Client {
  async function call<T>(
    isValid: Guard<T>,
    path: string,
    { signal, ...init }: CallInit,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([options.signal, signal])
      : options.signal;
    try {
      const value = await request(path, {
        ...init,
        token: options.token,
        signal: combined,
      });
      combined.throwIfAborted();
      if (isValid(value)) return value;
      throw new HttpError('The server returned an invalid response.');
    } catch (error) {
      // A late 401 of an ended session or a replaced panel must not sign
      // out its successor.
      combined.throwIfAborted();
      const refused =
        error instanceof HttpError && error.status === UNAUTHORIZED;
      if (refused) options.onRefused();
      throw error;
    }
  }

  // Every admin action answers with the user's row after its write.
  const act = (method: string, path: string, init: CallInit) =>
    call(isUserRow, path, { ...init, method });

  return {
    // Until the table pages, it shows the first page of the list.
    users: async (signal) =>
      (await call(isUsersPage, `${ADMIN_PATH}/users`, { signal })).rows,
    detail: (id, signal) => call(isDetail, userPath(id), { signal }),
    history: (id, range, signal) =>
      call(isHistory, `${userPath(id)}/history?range=${range}`, { signal }),
    analytics: (signal) =>
      call(isAnalytics, `${ADMIN_PATH}/analytics`, { signal }),
    reset: (id, signal) => act('POST', `${userPath(id)}/reset`, { signal }),
    setLimit: (id, body, signal) =>
      act('PUT', `${userPath(id)}/limit`, { signal, body }),
    suspend: (id, body, signal) =>
      act('POST', `${userPath(id)}/suspension`, { signal, body }),
    unsuspend: (id, signal) =>
      act('DELETE', `${userPath(id)}/suspension`, { signal }),
    addExtra: (id, body, signal) =>
      act('POST', `${userPath(id)}/extra`, { signal, body }),
  };
}
