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

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2036-01-01') });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('fixtures stay current years later and refresh panels on the counter while time stays fixed', async () => {
  const controller = new AbortController();
  const client = createClient({
    token: 'demo',
    signal: controller.signal,
    onRefused: vi.fn(),
  });
  const detail = vi.spyOn(client, 'detail');
  const cards = vi.spyOn(client, 'analytics');
  const snapshots = vi.spyOn(client, 'users');
  const session: Session = {
    token: 'demo',
    signal: controller.signal,
    client,
    onRefused: vi.fn(),
  };
  const { result, unmount } = renderHook(() => {
    const live = useLiveUsers(session);
    return {
      live,
      detail: useRequest(
        'detail:user-09',
        (signal) => client.detail('user-09', signal),
        live.tick,
      ),
      analytics: useRequest(
        'analytics',
        (signal) => client.analytics(signal),
        live.tick,
      ),
    };
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(clock()).toBe(Date.parse(NOW));
  expect(Date.parse(RESET_AT)).toBeGreaterThan(result.current.live.now);
  expect(
    Date.parse(result.current.live.rows.get('user-09')?.suspendedUntil ?? ''),
  ).toBeGreaterThan(result.current.live.now);
  expect(result.current.detail.data?.recentRequests).not.toHaveLength(0);
  expect(
    result.current.detail.data?.recentRequests.every(
      (record) => Date.parse(record.at) > result.current.live.now - 86_400_000,
    ),
  ).toBe(true);
  expect(snapshots).toHaveBeenCalledTimes(1);
  const detailLoads = detail.mock.calls.length;
  const cardLoads = cards.mock.calls.length;
  const tick = result.current.live.tick;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(result.current.live.now).toBe(Date.parse(NOW));
  expect(result.current.live.tick).toBe(tick + 1);
  expect(detail).toHaveBeenCalledTimes(detailLoads + 1);
  expect(cards).toHaveBeenCalledTimes(cardLoads + 1);
  expect(snapshots).toHaveBeenCalledTimes(2);
  unmount();
  controller.abort();
});

it('fixture actions acknowledge increasing versions without mutating frozen rows', async () => {
  const client = createClient({
    token: 'demo',
    signal: new AbortController().signal,
    onRefused: vi.fn(),
  });
  const first = client.reset('user-01');
  await vi.advanceTimersByTimeAsync(150);
  await expect(first).resolves.toEqual({
    ...users[0],
    version: users[0].version + 1,
  });
  const second = client.setLimit('user-01', { limit: 250 });
  await vi.advanceTimersByTimeAsync(150);
  await expect(second).resolves.toEqual({
    ...users[0],
    version: users[0].version + 2,
  });
  expect(users[0].version).toBe(12);
});

it('fixture requests stop for either request or session cancellation', async () => {
  const session = new AbortController();
  const request = new AbortController();
  const client = createClient({
    token: 'demo',
    signal: session.signal,
    onRefused: vi.fn(),
  });
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
  await vi.advanceTimersByTimeAsync(300);
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
