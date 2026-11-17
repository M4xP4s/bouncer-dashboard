import { MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserDetail, UserRow } from '@app/contracts';
import { HttpError } from './api/http.ts';
import {
  analytics,
  limitExceeded,
  NOW,
  requestUpdate,
  users,
} from './fixtures/index.ts';
import { deferred, mockClient, mockSocket } from './lib/test-helpers.ts';
import App from './App.tsx';

const transport = vi.hoisted(() => ({
  client: null as unknown,
  socket: null as unknown,
}));
vi.mock('./api/index.ts', () => ({
  createClient: () => transport.client,
  openSocket: () => transport.socket,
  clock: () => Date.now(),
}));
const now = Date.parse(NOW);
let client: ReturnType<typeof mockClient>;
let socket: ReturnType<typeof mockSocket>;
beforeEach(() => {
  vi.useFakeTimers({ now });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  sessionStorage.setItem('adminToken', 'demo');
  client = mockClient();
  socket = mockSocket();
  transport.client = client;
  transport.socket = socket;
  client.users.mockResolvedValue(users);
  client.analytics.mockResolvedValue(analytics);
  client.detail.mockImplementation(async (id) => ({
    row: users.find((row) => row.userId === id)!,
    recentRequests: [],
  }));
  client.history.mockResolvedValue([]);
});
afterEach(() => {
  notifications.clean();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
async function open() {
  render(
    <MantineProvider>
      <Notifications />
      <App />
    </MantineProvider>,
  );
  await act(async () => socket.listeners.connect.forEach((fn) => fn()));
}

it('keeps the table live after closing the labelled drawer and restores focus', async () => {
  await open();
  const button = screen.getByRole('button', { name: 'user-01' });
  button.focus();
  fireEvent.click(button);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(
    screen.getByRole('button', { name: 'Close user details' }),
  ).toBeTruthy();
  const close = screen.getByRole('button', { name: 'Close user details' });
  close.focus();
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Escape' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(document.activeElement).toBe(button);
  act(() => socket.listeners['rate:update'].forEach((fn) => fn(requestUpdate)));
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('87 / 100'),
  ).toBeTruthy();
});

it('announces a current exceeded event', async () => {
  await open();
  act(() =>
    socket.listeners['rate:limit_exceeded'].forEach((fn) => fn(limitExceeded)),
  );
  expect(screen.getByText('Limit exceeded: user-05')).toBeTruthy();
  expect(screen.getByText('Retry at 11:00:00 UTC')).toBeTruthy();
});

it('merges an event received during a delayed detail and removes it at the idle 24-hour reconciliation', async () => {
  const detail = deferred<UserDetail>();
  client.detail
    .mockReturnValueOnce(detail.promise)
    .mockResolvedValue({ row: users[0], recentRequests: [] });
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'user-01' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  const record = {
    ...requestUpdate.request!,
    at: new Date(now - 86400000 + 10000).toISOString(),
  };
  const event = { ...requestUpdate, request: record };
  act(() => socket.listeners['rate:update'].forEach((fn) => fn(event)));
  const region = screen.getByRole('region', { name: 'Recent requests' });
  expect(within(region).getByText('allowed')).toBeTruthy();
  await act(async () => detail.resolve({ row: users[0], recentRequests: [] }));
  expect(within(region).getByText('allowed')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(within(region).queryByText('allowed')).toBeNull();
});

it('applies an action to the original held row after opening another user', async () => {
  const response = deferred<UserRow>();
  client.reset.mockReturnValue(response.promise);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'user-01' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close user details' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.click(screen.getByRole('button', { name: 'user-02' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  await act(async () =>
    response.resolve({
      ...users[0],
      used: 0,
      remaining: 100,
      version: users[0].version + 1,
    }),
  );
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('100 / 100'),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('row', { name: /user-02/ })).getByText('50 / 100'),
  ).toBeTruthy();
  expect(screen.getByText(/Used 50; limit 100/)).toBeTruthy();
});

it('reconciles a failed action after its form was closed without leaking the error into another user', async () => {
  const response = deferred<UserRow>();
  client.reset.mockReturnValue(response.promise);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'user-01' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close user details' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.click(screen.getByRole('button', { name: 'user-02' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  const snapshotsBefore = client.users.mock.calls.length;
  // A failed reply is uncertain: the write may have landed, so the snapshot repairs its named row.
  client.users.mockResolvedValue(
    users.map((row) =>
      row.userId === 'user-01'
        ? { ...row, used: 0, remaining: 100, version: row.version + 1 }
        : row,
    ),
  );
  await act(async () =>
    response.reject(new HttpError('Reset outcome uncertain', 503)),
  );
  expect(client.reset).toHaveBeenCalledTimes(1);
  expect(client.users).toHaveBeenCalledTimes(snapshotsBefore + 1);
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('100 / 100'),
  ).toBeTruthy();
  expect(screen.getByText(/Used 50; limit 100/)).toBeTruthy();
  expect(screen.queryByText('Reset outcome uncertain')).toBeNull();
});

it('keeps the table working when analytics fails', async () => {
  client.analytics.mockRejectedValue(new Error('analytics unavailable'));
  await open();
  expect(screen.getByText(/analytics unavailable/)).toBeTruthy();
  act(() => socket.listeners['rate:update'].forEach((fn) => fn(requestUpdate)));
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('87 / 100'),
  ).toBeTruthy();
});

it('coalesces the connect refresh behind the mounted analytics load without fetching for events', async () => {
  const first = deferred<typeof analytics>();
  client.analytics.mockReturnValueOnce(first.promise);
  await open();
  expect(client.analytics).toHaveBeenCalledTimes(1);
  expect(client.analytics.mock.calls[0][0]?.aborted).toBe(false);
  act(() => socket.listeners['rate:update'].forEach((fn) => fn(requestUpdate)));
  expect(client.analytics).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(analytics));
  expect(client.analytics).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_999);
  });
  expect(client.analytics).toHaveBeenCalledTimes(2);
  expect(screen.getByText('64%')).toBeTruthy();
});

it('announces connection changes without announcing ordinary event or snapshot timestamps', async () => {
  await open();
  const status = screen.getByRole('status');
  const connected = status.textContent;
  act(() => socket.listeners['rate:update'].forEach((fn) => fn(requestUpdate)));
  expect(status.textContent).toBe(connected);
  expect(
    screen.getByText('Last update 10:42:01 UTC').closest('[role="status"]'),
  ).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(status.textContent).toBe(connected);
  expect(screen.getByText('Last update 10:42:10 UTC')).toBeTruthy();
  act(() => socket.listeners.disconnect.forEach((fn) => fn()));
  expect(status.textContent).toBe('Disconnected, reconnecting…');
  await act(async () => socket.listeners.connect.forEach((fn) => fn()));
  expect(status.textContent).toBe(connected);
});
