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
import { usersPage } from '../fixtures/usersPage.ts';
import { SECOND_MS } from '../lib/time.ts';
import type { Client, ClientOptions } from './client.ts';
import { HttpError } from './http.ts';
import type { LiveSocket, SocketEvents } from './socket.ts';

const RESPONSE_DELAY_MS = 150;
const NOT_FOUND = 404;

export const clock = () => Date.parse(NOW);

/** Answers with `read()` after the delay; rejects at once when cancelled. */
function delayed<T>(
  read: () => T,
  sessionSignal: AbortSignal,
  requestSignal?: AbortSignal,
): Promise<T> {
  const signal = requestSignal
    ? AbortSignal.any([sessionSignal, requestSignal])
    : sessionSignal;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      try {
        resolve(read());
      } catch (error) {
        reject(error);
      }
    }, RESPONSE_DELAY_MS);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function createClient(options: ClientOptions): Client {
  const rows = new Map(users.map((row) => [row.userId, row]));
  const respond = <T>(read: () => T, signal?: AbortSignal) =>
    delayed(read, options.signal, signal);

  function row(id: string): UserRow {
    const found = rows.get(id);
    if (!found) throw new HttpError('Unknown user.', NOT_FOUND);
    return found;
  }

  // An action only raises the version; quota policy is not simulated here.
  const action = (id: string, signal?: AbortSignal) =>
    respond(() => {
      const held = row(id);
      const updated = { ...held, version: held.version + 1 };
      rows.set(id, updated);
      return updated;
    }, signal);

  const detail = (id: string) => ({
    row: row(id),
    recentRequests: details[id]?.recentRequests ?? [],
  });

  const history = (id: string, range: string) => {
    row(id);
    return range === 'hour' ? historyHour : historyDay;
  };

  return {
    users: (query, signal) =>
      respond(() => usersPage([...rows.values()], query, clock()), signal),
    detail: (id, signal) => respond(() => detail(id), signal),
    history: (id, range, signal) => respond(() => history(id, range), signal),
    analytics: (signal) => respond(() => analytics, signal),
    reset: action,
    setLimit: (id, _body, signal) => action(id, signal),
    suspend: (id, _body, signal) => action(id, signal),
    unsuspend: action,
    addExtra: (id, _body, signal) => action(id, signal),
  };
}

/** A stand-in socket that connects, then plays three events and stops. */
export function openSocket(): LiveSocket {
  const listeners: { [K in keyof SocketEvents]: Set<SocketEvents[K]> } = {
    connect: new Set(),
    disconnect: new Set(),
    connect_error: new Set(),
    'rate:update': new Set(),
    'rate:limit_exceeded': new Set(),
  };
  const updates = listeners['rate:update'];
  const alerts = listeners['rate:limit_exceeded'];
  const timers = [
    setTimeout(() => listeners.connect.forEach((notify) => notify()), 0),
    setTimeout(
      () => updates.forEach((notify) => notify(requestUpdate)),
      2 * SECOND_MS,
    ),
    setTimeout(
      () => updates.forEach((notify) => notify(resetUpdate)),
      4 * SECOND_MS,
    ),
    setTimeout(
      () => alerts.forEach((notify) => notify(limitExceeded)),
      6 * SECOND_MS,
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
    disconnect: () => timers.forEach(clearTimeout),
  };
}
