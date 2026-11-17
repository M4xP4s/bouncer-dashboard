import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserRow } from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import type { Session } from '../api/useSession.ts';
import {
  NOW,
  RESET_AT,
  limitExceeded,
  requestUpdate,
  resetUpdate,
  users,
} from '../fixtures/index.ts';
import { deferred, mockClient, mockSocket } from '../lib/test-helpers.ts';
import { useLiveUsers } from './useLiveUsers.ts';

vi.mock('../api/index.ts', () => ({
  clock: vi.fn(() => Date.now()),
  openSocket: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW) });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.mocked(clock).mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function setup() {
  const controller = new AbortController();
  const client = mockClient();
  client.users.mockResolvedValue(users);
  const socket = mockSocket();
  vi.mocked(openSocket).mockReturnValue(socket);
  const session: Session = {
    token: 'admin',
    signal: controller.signal,
    client,
    onRefused: vi.fn(),
  };
  const alert = vi.fn();
  const hook = renderHook(() => useLiveUsers(session, alert));
  const connect = async () => {
    await act(async () =>
      socket.listeners.connect.forEach((listener) => listener()),
    );
  };
  return { ...hook, controller, client, socket, session, alert, connect };
}

it('loads on connect and reconnect, and keeps a newer event ahead of a slow snapshot', async () => {
  const h = setup();
  const pending = deferred<UserRow[]>();
  h.client.users.mockReturnValueOnce(pending.promise);
  expect(h.client.users).not.toHaveBeenCalled();
  await h.connect();
  act(() =>
    h.socket.listeners['rate:update'].forEach((listener) =>
      listener(requestUpdate),
    ),
  );
  await act(async () => pending.resolve(users));
  expect(h.result.current.rows.get('user-01')).toBe(requestUpdate.row);
  expect(h.result.current.snapshot.status).toBe('loaded');
  expect(h.result.current.connection).toBe('live');
  act(() => h.socket.listeners.disconnect.forEach((listener) => listener()));
  expect(h.result.current.connection).toBe('disconnected');
  await h.connect();
  expect(h.client.users).toHaveBeenCalledTimes(2);
});

it('serializes snapshots and coalesces all requests during a pending snapshot once', async () => {
  const h = setup();
  const pending = deferred<UserRow[]>();
  const next = deferred<UserRow[]>();
  h.client.users
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(next.promise);
  await h.connect();
  act(() => {
    h.result.current.refresh();
    h.result.current.refresh();
  });
  await h.connect();
  expect(h.client.users).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(users));
  expect(h.client.users).toHaveBeenCalledTimes(2);
  const repaired = { ...users[0], used: 11 };
  await act(async () => next.resolve([repaired]));
  expect(h.result.current.rows.get('user-01')).toBe(repaired);
  expect(h.client.users).toHaveBeenCalledTimes(2);
});

it('ticks every 10 seconds while visible, pauses while hidden, and reconciles on visibility', async () => {
  const h = setup();
  await h.connect();
  const initialTick = h.result.current.tick;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.client.users).toHaveBeenCalledTimes(2);
  expect(h.result.current.tick).toBe(initialTick + 1);
  expect(h.result.current.now).toBe(Date.parse(NOW) + 10_000);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(h.client.users).toHaveBeenCalledTimes(2);
  expect(h.result.current.tick).toBe(initialTick + 1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(h.client.users).toHaveBeenCalledTimes(3);
  expect(h.result.current.now).toBe(Date.parse(NOW) + 30_000);
});

it.each(['old window', 'error'] as const)(
  'reconciles a boundary once when the snapshot returns %s',
  async (outcome) => {
    vi.setSystemTime(Date.parse(RESET_AT) - 5_000);
    const h = setup();
    await h.connect();
    if (outcome === 'error')
      h.client.users.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(h.client.users).toHaveBeenCalledTimes(2);
    expect(h.result.current.now).toBe(Date.parse(RESET_AT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(h.client.users).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(h.client.users).toHaveBeenCalledTimes(3);
    expect(h.result.current.rows.size).toBe(users.length);
  },
);

it('does not schedule a boundary that is already past', async () => {
  vi.setSystemTime(Date.parse(RESET_AT) + 1);
  const h = setup();
  await h.connect();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_999);
  });
  expect(h.client.users).toHaveBeenCalledTimes(1);
});

it('a failed reconciliation keeps existing rows and reports the error', async () => {
  const h = setup();
  await h.connect();
  const held = h.result.current.rows;
  const error = new Error('snapshot unavailable');
  h.client.users.mockRejectedValueOnce(error);
  await act(async () => h.result.current.refresh());
  expect(h.result.current.rows).toBe(held);
  expect(h.result.current.snapshot).toEqual({ status: 'error', error });
});

it('retains a snapshot failure while its queued refresh is pending and clears it on success', async () => {
  const h = setup();
  await h.connect();
  const heldRows = h.result.current.rows;
  const failed = deferred<UserRow[]>();
  const queued = deferred<UserRow[]>();
  h.client.users
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(queued.promise);
  act(() => {
    h.result.current.refresh();
    h.result.current.refresh();
  });
  const error = new Error('The request timed out after 10 seconds.');
  await act(async () => failed.reject(error));
  expect(h.client.users).toHaveBeenCalledTimes(3);
  expect(h.result.current.snapshot).toEqual({ status: 'error', error });
  expect(h.result.current.rows).toBe(heldRows);
  await act(async () => queued.resolve(users));
  expect(h.result.current.snapshot).toEqual({ status: 'loaded', error: null });
});

it('applies current alerts once, drops stale alerts whole, and never fetches for events', () => {
  const h = setup();
  act(() => {
    h.socket.listeners['rate:limit_exceeded'].forEach((listener) =>
      listener(limitExceeded),
    );
    h.socket.listeners['rate:limit_exceeded'].forEach((listener) =>
      listener(limitExceeded),
    );
    h.socket.listeners['rate:update'].forEach((listener) =>
      listener(resetUpdate),
    );
  });
  expect(h.alert).toHaveBeenCalledExactlyOnceWith(limitExceeded);
  expect(h.result.current.liveRecords.get('user-05')).toEqual([
    limitExceeded.request,
  ]);
  act(() =>
    h.result.current.applyRow({ ...limitExceeded.row, version: 102, used: 0 }),
  );
  act(() =>
    h.socket.listeners['rate:limit_exceeded'].forEach((listener) =>
      listener(limitExceeded),
    ),
  );
  expect(h.alert).toHaveBeenCalledTimes(1);
  expect(h.result.current.rows.get('user-05')?.used).toBe(0);
  expect(h.client.users).not.toHaveBeenCalled();
});

it('keeps the newest 100 applied live records per user and ignores obsolete requests', () => {
  const h = setup();
  act(() => {
    for (let index = 0; index < 105; index++) {
      const event = {
        ...requestUpdate,
        row: { ...requestUpdate.row, version: index + 20 },
        request: {
          ...limitExceeded.request,
          id: `request-${index}`,
          at: new Date(Date.parse(NOW) + index).toISOString(),
        },
      };
      h.socket.listeners['rate:update'].forEach((listener) => listener(event));
    }
    h.socket.listeners['rate:update'].forEach((listener) =>
      listener(requestUpdate),
    );
  });
  const records = h.result.current.liveRecords.get('user-01');
  expect(records).toHaveLength(100);
  expect(records?.[0].id).toBe('request-104');
  expect(records?.[99].id).toBe('request-5');
  expect(h.client.users).not.toHaveBeenCalled();
});

it('stops old callbacks, pending snapshots, row applies and refreshes on session abort', async () => {
  const h = setup();
  const pending = deferred<UserRow[]>();
  h.client.users.mockReturnValueOnce(pending.promise);
  const oldUpdate = [...h.socket.listeners['rate:update']][0];
  const oldError = [...h.socket.listeners.connect_error][0];
  await h.connect();
  act(() => h.result.current.refresh());
  h.controller.abort();
  const held = h.result.current;
  act(() => {
    oldUpdate(requestUpdate);
    oldError(new Error('Unauthorized'));
    held.applyRow(requestUpdate.row);
    held.refresh();
  });
  await act(async () => pending.resolve(users));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.result.current).toBe(held);
  expect(h.client.users).toHaveBeenCalledTimes(1);
  expect(h.session.onRefused).not.toHaveBeenCalled();
  expect(h.socket.disconnect).toHaveBeenCalledOnce();
});

it('removes exactly its own socket callbacks and timers when unmounted', async () => {
  const h = setup();
  await h.connect();
  const added = vi.mocked(h.socket.on).mock.calls;
  h.unmount();
  expect(vi.mocked(h.socket.off).mock.calls).toEqual(added);
  expect(h.socket.disconnect).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.client.users).toHaveBeenCalledTimes(1);
});

it('keeps a fixed clock but advances the panel refresh signal', async () => {
  vi.mocked(clock).mockReturnValue(Date.parse(NOW));
  vi.setSystemTime(new Date('2036-01-01'));
  const h = setup();
  await h.connect();
  const tick = h.result.current.tick;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.result.current.tick).toBe(tick + 3);
  expect(h.result.current.now).toBe(Date.parse(NOW));
  expect(h.client.users).toHaveBeenCalledTimes(4);
});

// A socket frame that is not a well-formed event must be ignored whole: no row,
// no live record and no alert. Without the guards one bad frame would put an
// invalid row (unknown status, unreadable time) into the live table.
it.each([
  [
    'rate:update',
    { ...requestUpdate, row: { ...requestUpdate.row, status: 'Bogus' } },
  ],
  ['rate:limit_exceeded', { ...limitExceeded, retryAt: 'soon' }],
] as const)('ignores a malformed %s event', (event, payload) => {
  const h = setup();
  act(() =>
    h.socket.listeners[event].forEach((listener) =>
      (listener as (value: unknown) => void)(payload),
    ),
  );
  expect(h.result.current.rows.size).toBe(0);
  expect(h.result.current.liveRecords.size).toBe(0);
  expect(h.alert).not.toHaveBeenCalled();
});
