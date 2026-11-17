import type { UserRow } from '@app/contracts';
import {
  NOW,
  analytics,
  details,
  historyDay,
  historyHour,
  limitExceeded,
  requestUpdate,
  resetUpdate,
  users,
} from '../fixtures/index.ts';
import type { Client, ClientOptions } from './client.ts';
import { HttpError } from './http.ts';
import type { LiveSocket, SocketEvents } from './socket.ts';

export const clock = () => Date.parse(NOW);

export function createClient(options: ClientOptions): Client {
  const rows = new Map(users.map((row) => [row.userId, row]));

  function delayed<T>(read: () => T, requestSignal?: AbortSignal): Promise<T> {
    const signal = requestSignal
      ? AbortSignal.any([options.signal, requestSignal])
      : options.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        try {
          signal.throwIfAborted();
          resolve(read());
        } catch (error) {
          reject(error);
        }
      }, 150);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function row(id: string): UserRow {
    const found = rows.get(id);
    if (!found) throw new HttpError('Unknown user.', 404);
    return found;
  }

  // Fixture actions acknowledge a new version; they deliberately do not simulate quota policy.
  const action = (id: string, signal?: AbortSignal) =>
    delayed(() => {
      const updated = { ...row(id), version: row(id).version + 1 };
      rows.set(id, updated);
      return updated;
    }, signal);

  return {
    users: (signal) => delayed(() => [...rows.values()], signal),
    detail: (id, signal) =>
      delayed(
        () => ({
          row: row(id),
          recentRequests: details[id]?.recentRequests ?? [],
        }),
        signal,
      ),
    history: (id, range, signal) =>
      delayed(() => {
        row(id);
        return range === 'hour' ? historyHour : historyDay;
      }, signal),
    analytics: (signal) => delayed(() => analytics, signal),
    reset: action,
    setLimit: (id, _body, signal) => action(id, signal),
    suspend: (id, _body, signal) => action(id, signal),
    unsuspend: action,
    addExtra: (id, _body, signal) => action(id, signal),
  };
}

export function openSocket(): LiveSocket {
  const listeners: { [K in keyof SocketEvents]: Set<SocketEvents[K]> } = {
    connect: new Set(),
    disconnect: new Set(),
    connect_error: new Set(),
    'rate:update': new Set(),
    'rate:limit_exceeded': new Set(),
  };
  const timers = [
    setTimeout(() => listeners.connect.forEach((fn) => fn()), 0),
    setTimeout(
      () => listeners['rate:update'].forEach((fn) => fn(requestUpdate)),
      2_000,
    ),
    setTimeout(
      () => listeners['rate:update'].forEach((fn) => fn(resetUpdate)),
      4_000,
    ),
    setTimeout(
      () => listeners['rate:limit_exceeded'].forEach((fn) => fn(limitExceeded)),
      6_000,
    ),
  ];
  return {
    active: true,
    on: (event, listener) => {
      listeners[event].add(listener);
    },
    off: (event, listener) => {
      listeners[event].delete(listener);
    },
    disconnect: () => {
      timers.forEach(clearTimeout);
    },
  };
}
