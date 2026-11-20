import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  UsersPage,
  UsersQuery,
} from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import type { Session } from '../api/useSession.ts';
import { DEFAULT_USERS_QUERY } from '../api/usersQuery.ts';
import {
  NOW,
  RESET_AT,
  limitExceeded,
  requestUpdate,
  resetUpdate,
  users,
} from '../fixtures/index.ts';
import {
  deferred,
  mockClient,
  mockSocket,
  pageOf,
} from '../lib/test-helpers.ts';
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

const SECOND_PAGE: UsersQuery = { ...DEFAULT_USERS_QUERY, page: 2 };

function setup(selected: string | null = null) {
  const controller = new AbortController();
  const client = mockClient();
  client.users.mockResolvedValue(pageOf(users));
  const socket = mockSocket();
  vi.mocked(openSocket).mockReturnValue(socket);
  const session: Session = {
    token: 'admin',
    signal: controller.signal,
    client,
    onRefused: vi.fn(),
  };
  const onLimitExceeded = vi.fn();
  const hook = renderHook(
    (view) => useLiveUsers(session, view.query, view.selected, onLimitExceeded),
    { initialProps: { query: DEFAULT_USERS_QUERY, selected } },
  );
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
  const slowSnapshot = deferred<UsersPage>();
  client.users.mockReturnValueOnce(slowSnapshot.promise);
  expect(client.users).not.toHaveBeenCalled();

  await connect();
  act(() => emitUpdate(requestUpdate));
  await act(async () => slowSnapshot.resolve(pageOf(users)));
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
  const pending = deferred<UsersPage>();
  const queued = deferred<UsersPage>();
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
  // Asking again must not cancel the read that is running.
  expect(client.users.mock.calls[0][1]?.aborted).toBe(false);

  await act(async () => pending.resolve(pageOf(users)));
  expect(client.users).toHaveBeenCalledTimes(2);

  const repaired = { ...users[0], used: 11 };
  await act(async () => queued.resolve(pageOf([repaired])));
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
  ['old window', () => Promise.resolve(pageOf(users))],
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
  const failed = deferred<UsersPage>();
  const queued = deferred<UsersPage>();
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

  await act(async () => queued.resolve(pageOf(users)));
  expect(result.current.snapshot).toEqual({ status: 'loaded', error: null });
});

it('alerts for every limit event, whatever row is held, and never fetches for events', () => {
  const { result, client, onLimitExceeded, emitUpdate, emitExceeded } =
    setup('user-05');

  act(() => {
    emitExceeded(limitExceeded);
    emitUpdate(resetUpdate);
  });
  expect(onLimitExceeded).toHaveBeenCalledExactlyOnceWith(limitExceeded);
  const records = result.current.liveRecords;
  expect(records.get('user-05')).toEqual([limitExceeded.request]);

  act(() =>
    result.current.applyRow({ ...limitExceeded.row, version: 102, used: 0 }),
  );
  act(() => emitExceeded(limitExceeded));
  expect(onLimitExceeded).toHaveBeenCalledTimes(2);
  expect(result.current.rows.get('user-05')?.used).toBe(0);
  expect(result.current.liveRecords).toBe(records);
  expect(client.users).not.toHaveBeenCalled();
});

it('alerts although a snapshot already holds the version of the rejection', async () => {
  const { result, client, connect, onLimitExceeded, emitExceeded } = setup();
  // Read after the rejection was counted and before its entry was removed.
  const overtaking = { ...limitExceeded.row, used: 101 };
  client.users.mockResolvedValue(pageOf([overtaking]));
  await connect();

  act(() => emitExceeded(limitExceeded));

  expect(onLimitExceeded).toHaveBeenCalledExactlyOnceWith(limitExceeded);
  expect(result.current.rows.get('user-05')).toBe(overtaking);
});

it('keeps the newest 100 applied live records of the selected user and ignores obsolete requests', () => {
  const { result, client, emitUpdate } = setup('user-01');

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

it('stops old callbacks, alerts, pending snapshots, row applies and refreshes on session abort', async () => {
  const {
    result,
    controller,
    client,
    socket,
    session,
    connect,
    onLimitExceeded,
  } = setup();
  const pending = deferred<UsersPage>();
  client.users.mockReturnValueOnce(pending.promise);
  // Taken before the abort unregisters them: a late frame can still call them.
  const [oldUpdate] = socket.listeners['rate:update'];
  const [oldExceeded] = socket.listeners['rate:limit_exceeded'];
  const [oldError] = socket.listeners.connect_error;
  await connect();
  act(() => result.current.refresh());

  controller.abort();
  const held = result.current;
  act(() => {
    oldUpdate(requestUpdate);
    oldExceeded(limitExceeded);
    oldError(new Error('Unauthorized'));
    held.applyRow(requestUpdate.row);
    held.refresh();
  });
  await act(async () => pending.resolve(pageOf(users)));
  await advanceTime(30_000);

  expect(result.current).toBe(held);
  expect(client.users).toHaveBeenCalledTimes(1);
  expect(onLimitExceeded).not.toHaveBeenCalled();
  expect(session.onRefused).not.toHaveBeenCalled();
  expect(socket.disconnect).toHaveBeenCalledOnce();
});

it('removes exactly its own socket callbacks and timers when unmounted', async () => {
  const { client, socket, connect, unmount } = setup();
  await connect();
  const added = vi.mocked(socket.on).mock.calls;

  unmount();

  expect(vi.getTimerCount()).toBe(0);
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

const heldUserIds = (rows: ReadonlyMap<string, unknown>) => [...rows.keys()];

it('a new page keeps the socket, drops the old page and its late response, and keeps the selected user', async () => {
  const { result, client, connect, rerender } = setup('user-01');
  await connect();
  const oldPage = deferred<UsersPage>();
  client.users
    .mockReturnValueOnce(oldPage.promise)
    .mockResolvedValueOnce(pageOf([users[1]], { page: 2 }));
  act(() => result.current.refresh());
  const oldSignal = client.users.mock.calls[1][1];

  rerender({ query: SECOND_PAGE, selected: 'user-01' });
  expect(oldSignal?.aborted).toBe(true);
  expect(result.current.page).toBeNull();
  expect(heldUserIds(result.current.rows)).toEqual(['user-01']);

  await act(async () => oldPage.resolve(pageOf(users)));
  expect(client.users).toHaveBeenLastCalledWith(
    SECOND_PAGE,
    expect.any(AbortSignal),
  );
  expect(result.current.page?.page).toBe(2);
  expect(heldUserIds(result.current.rows).sort()).toEqual([
    'user-01',
    'user-02',
  ]);
  expect(openSocket).toHaveBeenCalledOnce();

  rerender({ query: SECOND_PAGE, selected: null });
  expect(heldUserIds(result.current.rows)).toEqual(['user-02']);
});

it('applies the events that arrive during a page read over its response', async () => {
  const { result, client, connect, rerender, emitUpdate } = setup();
  await connect();
  const read = deferred<UsersPage>();
  client.users.mockReturnValueOnce(read.promise);
  rerender({ query: SECOND_PAGE, selected: null });

  // user-01 is on no held page yet; the response then carries version 12.
  act(() => emitUpdate(requestUpdate));
  await act(async () => read.resolve(pageOf(users, { page: 2 })));

  expect(result.current.rows.get('user-01')).toBe(requestUpdate.row);
  expect(client.users).toHaveBeenCalledTimes(2);
});

/** Events from `count` users who are on no page the tests read. */
function otherUsersUpdate(count: number, prefix = 'other') {
  return Array.from({ length: count }, (_, index) => ({
    ...requestUpdate,
    row: { ...requestUpdate.row, userId: `${prefix}-${index}` },
  }));
}

it('never reads because of events, however many users send them during reads', async () => {
  const { result, client, connect, emitUpdate } = setup();
  const firstRead = deferred<UsersPage>();
  const secondRead = deferred<UsersPage>();
  client.users
    .mockReturnValueOnce(firstRead.promise)
    .mockReturnValueOnce(secondRead.promise);
  await connect();

  act(() => otherUsersUpdate(101, 'first').forEach(emitUpdate));
  await act(async () => firstRead.resolve(pageOf(users)));
  expect(client.users).toHaveBeenCalledOnce();

  act(() => result.current.refresh());
  act(() => otherUsersUpdate(101, 'second').forEach(emitUpdate));
  await act(async () => secondRead.resolve(pageOf(users)));
  expect(client.users).toHaveBeenCalledTimes(2);
});

it('applies an on-page event over a reconcile that many off-page users sent events during', async () => {
  const { result, client, connect, emitUpdate } = setup();
  await connect();
  const read = deferred<UsersPage>();
  client.users.mockReturnValueOnce(read.promise);
  act(() => result.current.refresh());

  act(() => {
    otherUsersUpdate(101).forEach(emitUpdate);
    emitUpdate(requestUpdate);
  });
  await act(async () => read.resolve(pageOf(users)));

  expect(result.current.rows.get('user-01')).toBe(requestUpdate.row);
  expect(client.users).toHaveBeenCalledTimes(2);
});

it("shows the response row of a user past the cap on a new page until the user's next event", async () => {
  const { result, client, connect, rerender, emitUpdate } = setup();
  await connect();
  const read = deferred<UsersPage>();
  client.users.mockReturnValueOnce(read.promise);
  rerender({ query: SECOND_PAGE, selected: null });

  // The cap is full before user-01's event arrives, so that event is dropped.
  act(() => {
    otherUsersUpdate(100).forEach(emitUpdate);
    emitUpdate(requestUpdate);
  });
  await act(async () => read.resolve(pageOf(users, { page: 2 })));
  expect(result.current.rows.get('user-01')).toBe(users[0]);
  expect(client.users).toHaveBeenCalledTimes(2);

  const nextEvent = numberedRequest(0);
  act(() => emitUpdate(nextEvent));
  expect(result.current.rows.get('user-01')).toBe(nextEvent.row);
});

it('keeps nothing of an event off the page, but still alerts', async () => {
  const { result, client, connect, onLimitExceeded, emitUpdate, emitExceeded } =
    setup('user-01');
  client.users.mockResolvedValue(pageOf(users.slice(0, 2)));
  await connect();
  const heldRows = result.current.rows;

  act(() => {
    for (let index = 0; index < 1000; index++) {
      const userId = `other-${index}`;
      emitUpdate({ ...requestUpdate, row: { ...requestUpdate.row, userId } });
    }
    emitExceeded(limitExceeded);
  });

  expect(result.current.rows).toBe(heldRows);
  expect(result.current.liveRecords.size).toBe(0);
  expect(onLimitExceeded).toHaveBeenCalledExactlyOnceWith(limitExceeded);
  expect(client.users).toHaveBeenCalledTimes(1);
});

// user-09's suspension ends without a new version, so only a response that
// may replace an equal row can show that.
const suspended = users[8];
const suspensionEnded = { ...suspended, suspendedUntil: null };

it('repairs the selected user off the page from an equal detail response, never an older one', async () => {
  const { result, client, connect } = setup('user-09');
  client.users.mockResolvedValue(pageOf([users[0]]));
  await connect();
  act(() => result.current.applyDetailRow(suspended));

  const older = { ...suspensionEnded, version: suspended.version - 1 };
  act(() => result.current.applyDetailRow(older));
  expect(result.current.rows.get('user-09')).toBe(suspended);

  act(() => result.current.applyDetailRow(suspensionEnded));
  expect(result.current.rows.get('user-09')).toBe(suspensionEnded);
});

it('leaves a row on the page to the page read, even for an equal detail response', async () => {
  const { result, client, connect } = setup('user-09');
  client.users.mockResolvedValue(pageOf([suspended]));
  await connect();

  act(() => result.current.applyDetailRow(suspensionEnded));

  expect(result.current.rows.get('user-09')).toBe(suspended);
});

it('keeps the users the table holds in place once the page drops them, with their events, until let go', async () => {
  const { result, client, connect, emitUpdate } = setup();
  client.users.mockResolvedValue(pageOf(users.slice(0, 2)));
  await connect();
  act(() => result.current.keep(['user-01', 'user-02']));

  client.users.mockResolvedValue(pageOf([users[1]]));
  await act(async () => result.current.refresh());
  expect(heldUserIds(result.current.rows).sort()).toEqual([
    'user-01',
    'user-02',
  ]);

  act(() => emitUpdate(requestUpdate));
  expect(result.current.rows.get('user-01')).toBe(requestUpdate.row);

  act(() => result.current.keep([]));
  expect(heldUserIds(result.current.rows)).toEqual(['user-02']);
});

it('repairs a user held in place off the page from an equal detail response', async () => {
  const { result, client, connect } = setup();
  client.users.mockResolvedValue(pageOf([users[0], suspended]));
  await connect();
  act(() => result.current.keep(['user-01', 'user-09']));
  client.users.mockResolvedValue(pageOf([users[0]]));
  await act(async () => result.current.refresh());

  act(() => result.current.applyDetailRow(suspensionEnded));

  expect(result.current.rows.get('user-09')).toBe(suspensionEnded);
});

it('a new page drops the users held in place', async () => {
  const { result, client, connect, rerender } = setup();
  client.users.mockResolvedValue(pageOf(users.slice(0, 2)));
  await connect();
  act(() => result.current.keep(['user-01', 'user-02']));
  client.users.mockReturnValueOnce(deferred<UsersPage>().promise);

  rerender({ query: SECOND_PAGE, selected: null });

  expect(heldUserIds(result.current.rows)).toEqual([]);
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
