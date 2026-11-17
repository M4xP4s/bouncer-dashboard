import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  UserRow,
} from '@app/contracts';
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
  const onLimitExceeded = vi.fn();
  const hook = renderHook(() => useLiveUsers(session, onLimitExceeded));
  const connect = async () => {
    await act(async () =>
      socket.listeners.connect.forEach((listener) => listener()),
    );
  };
  const emitUpdate = (event: RateUpdateEvent) =>
    socket.listeners['rate:update'].forEach((listener) => listener(event));
  const emitExceeded = (event: RateLimitExceededEvent) =>
    socket.listeners['rate:limit_exceeded'].forEach((listener) =>
      listener(event),
    );
  return {
    ...hook,
    controller,
    client,
    socket,
    session,
    onLimitExceeded,
    connect,
    emitUpdate,
    emitExceeded,
  };
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
}

/** user-01's next request: one version and one millisecond after the last. */
function numberedRequest(index: number): RateUpdateEvent {
  const at = new Date(Date.parse(NOW) + index).toISOString();
  return {
    ...requestUpdate,
    row: { ...requestUpdate.row, version: index + 20 },
    request: { ...limitExceeded.request, id: `request-${index}`, at },
  };
}

it('loads on connect and reconnect, and keeps a newer event ahead of a slow snapshot', async () => {
  const { result, client, socket, connect, emitUpdate } = setup();
  const slowSnapshot = deferred<UserRow[]>();
  client.users.mockReturnValueOnce(slowSnapshot.promise);
  expect(client.users).not.toHaveBeenCalled();

  await connect();
  act(() => emitUpdate(requestUpdate));
  await act(async () => slowSnapshot.resolve(users));
  expect(result.current.rows.get('user-01')).toBe(requestUpdate.row);
  expect(result.current.snapshot.status).toBe('loaded');
  expect(result.current.connection).toBe('live');

  act(() => socket.listeners.disconnect.forEach((listener) => listener()));
  expect(result.current.connection).toBe('disconnected');

  await connect();
  expect(client.users).toHaveBeenCalledTimes(2);
});

it('serializes snapshots and coalesces all requests during a pending snapshot once', async () => {
  const { result, client, connect } = setup();
  const pending = deferred<UserRow[]>();
  const queued = deferred<UserRow[]>();
  client.users
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(queued.promise);

  await connect();
  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  await connect();
  expect(client.users).toHaveBeenCalledTimes(1);

  await act(async () => pending.resolve(users));
  expect(client.users).toHaveBeenCalledTimes(2);

  const repaired = { ...users[0], used: 11 };
  await act(async () => queued.resolve([repaired]));
  expect(result.current.rows.get('user-01')).toBe(repaired);
  expect(client.users).toHaveBeenCalledTimes(2);
});

it('ticks every 10 seconds while visible, pauses while hidden, and reconciles on visibility', async () => {
  const { result, client, connect } = setup();
  await connect();
  const initialTick = result.current.tick;

  await advanceTime(10_000);
  expect(client.users).toHaveBeenCalledTimes(2);
  expect(result.current.tick).toBe(initialTick + 1);
  expect(result.current.now).toBe(Date.parse('2026-11-16T10:42:10.000Z'));

  await setVisibility('hidden');
  await advanceTime(20_000);
  expect(client.users).toHaveBeenCalledTimes(2);
  expect(result.current.tick).toBe(initialTick + 1);

  await setVisibility('visible');
  expect(client.users).toHaveBeenCalledTimes(3);
  expect(result.current.now).toBe(Date.parse('2026-11-16T10:42:30.000Z'));
});

it.each([
  ['old window', () => Promise.resolve(users)],
  ['error', () => Promise.reject(new Error('offline'))],
])(
  'reconciles a boundary once when the snapshot returns %s',
  async (_outcome, snapshotAtBoundary) => {
    vi.setSystemTime(Date.parse(RESET_AT) - 5_000);
    const { result, client, connect } = setup();
    await connect();
    client.users.mockImplementationOnce(snapshotAtBoundary);

    await advanceTime(5_000);
    expect(client.users).toHaveBeenCalledTimes(2);
    expect(result.current.now).toBe(Date.parse(RESET_AT));

    // The third snapshot is the regular 10-second tick, not a second boundary.
    await advanceTime(4_999);
    expect(client.users).toHaveBeenCalledTimes(2);
    await advanceTime(1);
    expect(client.users).toHaveBeenCalledTimes(3);
    expect(result.current.rows.size).toBe(users.length);
  },
);

it('does not schedule a boundary that is already past', async () => {
  vi.setSystemTime(Date.parse(RESET_AT) + 1);
  const { client, connect } = setup();
  await connect();

  await advanceTime(9_999);

  expect(client.users).toHaveBeenCalledTimes(1);
});

it('a failed reconciliation keeps existing rows and reports the error', async () => {
  const { result, client, connect } = setup();
  await connect();
  const heldRows = result.current.rows;
  const error = new Error('snapshot unavailable');
  client.users.mockRejectedValueOnce(error);

  await act(async () => result.current.refresh());

  expect(result.current.rows).toBe(heldRows);
  expect(result.current.snapshot).toEqual({ status: 'error', error });
});

it('retains a snapshot failure while its queued refresh is pending and clears it on success', async () => {
  const { result, client, connect } = setup();
  await connect();
  const heldRows = result.current.rows;
  const failed = deferred<UserRow[]>();
  const queued = deferred<UserRow[]>();
  client.users
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(queued.promise);

  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  const error = new Error('The request timed out after 10 seconds.');
  await act(async () => failed.reject(error));
  expect(client.users).toHaveBeenCalledTimes(3);
  expect(result.current.snapshot).toEqual({ status: 'error', error });
  expect(result.current.rows).toBe(heldRows);

  await act(async () => queued.resolve(users));
  expect(result.current.snapshot).toEqual({ status: 'loaded', error: null });
});

it('applies current alerts once, drops stale alerts whole, and never fetches for events', () => {
  const { result, client, onLimitExceeded, emitUpdate, emitExceeded } = setup();

  act(() => {
    emitExceeded(limitExceeded);
    emitExceeded(limitExceeded);
    emitUpdate(resetUpdate);
  });
  expect(onLimitExceeded).toHaveBeenCalledExactlyOnceWith(limitExceeded);
  expect(result.current.liveRecords.get('user-05')).toEqual([
    limitExceeded.request,
  ]);

  act(() =>
    result.current.applyRow({ ...limitExceeded.row, version: 102, used: 0 }),
  );
  act(() => emitExceeded(limitExceeded));
  expect(onLimitExceeded).toHaveBeenCalledTimes(1);
  expect(result.current.rows.get('user-05')?.used).toBe(0);
  expect(client.users).not.toHaveBeenCalled();
});

it('keeps the newest 100 applied live records per user and ignores obsolete requests', () => {
  const { result, client, emitUpdate } = setup();

  act(() => {
    for (let index = 0; index < 105; index++)
      emitUpdate(numberedRequest(index));
    // Obsolete: its version 13 is below every numbered request (20 and up).
    emitUpdate(requestUpdate);
  });

  const records = result.current.liveRecords.get('user-01');
  expect(records).toHaveLength(100);
  expect(records?.[0].id).toBe('request-104');
  expect(records?.[99].id).toBe('request-5');
  expect(client.users).not.toHaveBeenCalled();
});

it('stops old callbacks, pending snapshots, row applies and refreshes on session abort', async () => {
  const { result, controller, client, socket, session, connect } = setup();
  const pending = deferred<UserRow[]>();
  client.users.mockReturnValueOnce(pending.promise);
  // Taken before the abort unregisters them: a late frame can still call them.
  const [oldUpdate] = socket.listeners['rate:update'];
  const [oldError] = socket.listeners.connect_error;
  await connect();
  act(() => result.current.refresh());

  controller.abort();
  const held = result.current;
  act(() => {
    oldUpdate(requestUpdate);
    oldError(new Error('Unauthorized'));
    held.applyRow(requestUpdate.row);
    held.refresh();
  });
  await act(async () => pending.resolve(users));
  await advanceTime(30_000);

  expect(result.current).toBe(held);
  expect(client.users).toHaveBeenCalledTimes(1);
  expect(session.onRefused).not.toHaveBeenCalled();
  expect(socket.disconnect).toHaveBeenCalledOnce();
});

it('removes exactly its own socket callbacks and timers when unmounted', async () => {
  const { client, socket, connect, unmount } = setup();
  await connect();
  const added = vi.mocked(socket.on).mock.calls;

  unmount();

  expect(vi.mocked(socket.off).mock.calls).toEqual(added);
  expect(socket.disconnect).toHaveBeenCalledOnce();
  await advanceTime(30_000);
  expect(client.users).toHaveBeenCalledTimes(1);
});

it('keeps a fixed clock but advances the panel refresh signal', async () => {
  vi.mocked(clock).mockReturnValue(Date.parse(NOW));
  vi.setSystemTime(new Date('2036-01-01'));
  const { result, client, connect } = setup();
  await connect();
  const initialTick = result.current.tick;

  await advanceTime(30_000);

  expect(result.current.tick).toBe(initialTick + 3);
  expect(result.current.now).toBe(Date.parse(NOW));
  expect(client.users).toHaveBeenCalledTimes(4);
});

// One bad frame must not put an invalid row (unknown status, unreadable time)
// into the live table, so it is ignored whole: no row, no record, no alert.
it.each([
  [
    'rate:update',
    { ...requestUpdate, row: { ...requestUpdate.row, status: 'Bogus' } },
  ],
  ['rate:limit_exceeded', { ...limitExceeded, retryAt: 'soon' }],
] as const)('ignores a malformed %s event', (event, frame) => {
  const { result, socket, onLimitExceeded } = setup();

  // The cast stands in for the wire, which delivers JSON no type has checked.
  act(() =>
    socket.listeners[event].forEach((listener) =>
      (listener as (frame: unknown) => void)(frame),
    ),
  );

  expect(result.current.rows.size).toBe(0);
  expect(result.current.liveRecords.size).toBe(0);
  expect(onLimitExceeded).not.toHaveBeenCalled();
});
