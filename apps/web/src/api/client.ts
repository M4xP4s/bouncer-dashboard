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
  isUsers,
} from './validation.ts';

export interface ClientOptions {
  token: string;
  signal: AbortSignal;
  onRefused: () => void;
}

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

export function createClient(options: ClientOptions): Client {
  async function call<T>(
    path: string,
    valid: (value: unknown) => value is T,
    signal?: AbortSignal,
    method?: string,
    body?: unknown,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([options.signal, signal])
      : options.signal;
    try {
      const value = await request(path, {
        token: options.token,
        signal: combined,
        method,
        body,
      });
      combined.throwIfAborted();
      if (!valid(value))
        throw new HttpError('The server returned an invalid response.');
      return value;
    } catch (error) {
      // A late 401 from either an old session or an obsolete panel cannot sign out its successor.
      combined.throwIfAborted();
      if (error instanceof HttpError && error.status === 401)
        options.onRefused();
      throw error;
    }
  }

  const userPath = (userId: string) =>
    `/api/admin/users/${encodeURIComponent(userId)}`;
  return {
    users: (signal) => call('/api/admin/users', isUsers, signal),
    detail: (id, signal) => call(userPath(id), isDetail, signal),
    history: (id, range, signal) =>
      call(`${userPath(id)}/history?range=${range}`, isHistory, signal),
    analytics: (signal) => call('/api/admin/analytics', isAnalytics, signal),
    reset: (id, signal) =>
      call(`${userPath(id)}/reset`, isUserRow, signal, 'POST'),
    setLimit: (id, body, signal) =>
      call(`${userPath(id)}/limit`, isUserRow, signal, 'PUT', body),
    suspend: (id, body, signal) =>
      call(`${userPath(id)}/suspension`, isUserRow, signal, 'POST', body),
    unsuspend: (id, signal) =>
      call(`${userPath(id)}/suspension`, isUserRow, signal, 'DELETE'),
    addExtra: (id, body, signal) =>
      call(`${userPath(id)}/extra`, isUserRow, signal, 'POST', body),
  };
}
