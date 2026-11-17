import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NOW, RESET_AT, users } from '../fixtures/index.ts';
import { useLiveUsers } from '../live/useLiveUsers.ts';
import { useRequest } from '../lib/useRequest.ts';
import type { Session } from './useSession.ts';
import { clock, createClient, openSocket } from './fixture-client.ts';

vi.mock('./index.ts', async () => {
  const fixtures = await import('./fixture-client.ts');
  return {
    clock: fixtures.clock,
    createClient: fixtures.createClient,
    openSocket: fixtures.openSocket,
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
// The interval at which the dashboard reconciles while the page is visible.
const TICK_MS = 10_000;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2036-01-01') });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixtureClient(signal = new AbortController().signal) {
  return createClient({ token: 'demo', signal, onRefused: vi.fn() });
}

/** The hooks of a dashboard that has user-09's detail panel open. */
function usePanels(session: Session) {
  const live = useLiveUsers(session);
  const detail = useRequest(
    'detail:user-09',
    (signal) => session.client.detail('user-09', signal),
    live.tick,
  );
  const analytics = useRequest(
    'analytics',
    (signal) => session.client.analytics(signal),
    live.tick,
  );
  return { live, detail, analytics };
}

const advance = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

it('fixtures stay current years later and refresh panels on the counter while time stays fixed', async () => {
  const controller = new AbortController();
  const client = fixtureClient(controller.signal);
  const detailLoad = vi.spyOn(client, 'detail');
  const analyticsLoad = vi.spyOn(client, 'analytics');
  const snapshotLoad = vi.spyOn(client, 'users');
  const session: Session = {
    token: 'demo',
    signal: controller.signal,
    client,
    onRefused: vi.fn(),
  };
  const { result, unmount } = renderHook(() => usePanels(session));
  // Covers connecting, the first loads and the refresh queued behind them.
  await advance(400);

  const { live, detail } = result.current;
  expect(clock()).toBe(Date.parse(NOW));
  expect(Date.parse(RESET_AT)).toBeGreaterThan(live.now);
  expect(
    Date.parse(live.rows.get('user-09')?.suspendedUntil ?? ''),
  ).toBeGreaterThan(live.now);
  expect(detail.data?.recentRequests).not.toHaveLength(0);
  expect(
    detail.data?.recentRequests.every(
      (record) => Date.parse(record.at) > live.now - DAY_MS,
    ),
  ).toBe(true);
  expect(snapshotLoad).toHaveBeenCalledTimes(1);
  expect(live.tick).toBe(1);

  detailLoad.mockClear();
  analyticsLoad.mockClear();
  await advance(TICK_MS);
  // The fixture client replies after 150 ms.
  await advance(200);

  expect(result.current.live.now).toBe(Date.parse(NOW));
  expect(result.current.live.tick).toBe(2);
  expect(detailLoad).toHaveBeenCalledTimes(1);
  expect(analyticsLoad).toHaveBeenCalledTimes(1);
  expect(snapshotLoad).toHaveBeenCalledTimes(2);
  unmount();
  controller.abort();
});

it('fixture actions acknowledge increasing versions without mutating frozen rows', async () => {
  const client = fixtureClient();

  const reset = client.reset('user-01');
  await vi.advanceTimersByTimeAsync(150);
  await expect(reset).resolves.toEqual({ ...users[0], version: 13 });

  const limitChange = client.setLimit('user-01', { limit: 250 });
  await vi.advanceTimersByTimeAsync(150);
  await expect(limitChange).resolves.toEqual({ ...users[0], version: 14 });
  expect(users[0].version).toBe(12);
});

it('fixture requests stop for either request or session cancellation', async () => {
  const session = new AbortController();
  const request = new AbortController();
  const client = fixtureClient(session.signal);

  const read = client.users(request.signal);
  const readRejected = expect(read).rejects.toMatchObject({
    name: 'AbortError',
  });
  request.abort();
  await readRejected;

  const action = client.reset('user-01');
  const actionRejected = expect(action).rejects.toMatchObject({
    name: 'AbortError',
  });
  session.abort();
  await actionRejected;
});

it('the fixture socket emits its three events once and disconnect cancels delivery', async () => {
  const socket = openSocket();
  const connect = vi.fn();
  const update = vi.fn();
  const exceeded = vi.fn();
  socket.on('connect', connect);
  socket.on('rate:update', update);
  socket.on('rate:limit_exceeded', exceeded);

  await vi.advanceTimersByTimeAsync(6_000);
  expect(connect).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledTimes(2);
  expect(exceeded).toHaveBeenCalledOnce();
  socket.disconnect();

  const cancelled = openSocket();
  cancelled.on('connect', connect);
  cancelled.disconnect();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(connect).toHaveBeenCalledOnce();
});
