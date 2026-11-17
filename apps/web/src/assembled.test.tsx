import { MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  Analytics,
  RateUpdateEvent,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { HttpError } from './api/http.ts';
import {
  analytics,
  limitExceeded,
  NOW,
  requestUpdate,
  users,
} from './fixtures/index.ts';
import {
  deferred,
  mockClient,
  mockSocket,
  pageOf,
} from './lib/test-helpers.ts';
import App from './App.tsx';

let client: ReturnType<typeof mockClient>;
let socket: ReturnType<typeof mockSocket>;
// The mock reads both variables on each call, so every test gets a fresh pair.
vi.mock('./api/index.ts', () => ({
  createClient: () => client,
  openSocket: () => socket,
  clock: () => Date.now(),
}));

// The dashboard reconciles every ten seconds while the page is visible.
const TICK_MS = 10_000;
// Longer than the 200 ms the drawer takes to open or close.
const DRAWER_SETTLED_MS = 250;
const user01AfterReset: UserRow = {
  ...users[0],
  used: 0,
  remaining: 100,
  version: 13,
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW) });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  sessionStorage.setItem('adminToken', 'demo');
  client = mockClient();
  socket = mockSocket();
  client.users.mockResolvedValue(pageOf(users));
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

const connectSocket = () =>
  act(async () => socket.listeners.connect.forEach((listener) => listener()));

const receiveUpdate = (event: RateUpdateEvent) =>
  act(() =>
    socket.listeners['rate:update'].forEach((listener) => listener(event)),
  );

const advance = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

async function openDashboard() {
  render(
    <MantineProvider>
      <Notifications />
      <App />
    </MantineProvider>,
  );
  await connectSocket();
}

const press = (button: string) =>
  fireEvent.click(screen.getByRole('button', { name: button }));

async function openUser(userId: string) {
  press(userId);
  await advance(DRAWER_SETTLED_MS);
}

async function closeUserDetails() {
  press('Close user details');
  await advance(DRAWER_SETTLED_MS);
}

/** Starts a reset of user-01, then opens user-02 before the reply arrives. */
async function resetUser01ThenOpenUser02() {
  await openUser('user-01');
  press('Reset usage');
  await closeUserDetails();
  await openUser('user-02');
}

const tableRow = (userId: string) =>
  within(screen.getByRole('row', { name: new RegExp(userId) }));

it('keeps the table live after closing the labelled drawer and restores focus', async () => {
  await openDashboard();
  const userButton = screen.getByRole('button', { name: 'user-01' });
  userButton.focus();
  fireEvent.click(userButton);
  await advance(DRAWER_SETTLED_MS);
  const close = screen.getByRole('button', { name: 'Close user details' });
  close.focus();
  expect(document.activeElement).toBe(close);

  fireEvent.keyDown(close, { key: 'Escape' });
  await advance(DRAWER_SETTLED_MS);
  expect(document.activeElement).toBe(userButton);

  receiveUpdate(requestUpdate);
  expect(tableRow('user-01').getByText('87 / 100')).toBeTruthy();
});

it('announces a current exceeded event', async () => {
  await openDashboard();

  act(() =>
    socket.listeners['rate:limit_exceeded'].forEach((listener) =>
      listener(limitExceeded),
    ),
  );

  expect(screen.getByText('Limit exceeded: user-05')).toBeTruthy();
  expect(screen.getByText('Retry at 11:00:00 UTC')).toBeTruthy();
});

it('merges an event received during a delayed detail and removes it at the idle 24-hour reconciliation', async () => {
  const detail = deferred<UserDetail>();
  client.detail
    .mockReturnValueOnce(detail.promise)
    .mockResolvedValue({ row: users[0], recentRequests: [] });
  // Turns 24 hours old ten seconds after NOW, at the next tick.
  const agingRequest: RequestRecord = {
    id: 'req-01-013',
    at: '2026-11-15T10:42:10.000Z',
    outcome: 'allowed',
    remaining: 87,
  };
  await openDashboard();
  await openUser('user-01');

  receiveUpdate({ ...requestUpdate, request: agingRequest });
  const requests = within(
    screen.getByRole('region', { name: 'Recent requests' }),
  );
  expect(requests.getByText('allowed')).toBeTruthy();

  await act(async () => detail.resolve({ row: users[0], recentRequests: [] }));
  expect(requests.getByText('allowed')).toBeTruthy();

  await advance(TICK_MS);
  expect(requests.queryByText('allowed')).toBeNull();
});

it('applies an action to the original held row after opening another user', async () => {
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  await openDashboard();
  await resetUser01ThenOpenUser02();

  await act(async () => reset.resolve(user01AfterReset));

  expect(tableRow('user-01').getByText('100 / 100')).toBeTruthy();
  expect(tableRow('user-02').getByText('50 / 100')).toBeTruthy();
  expect(screen.getByText(/Used 50; limit 100/)).toBeTruthy();
});

it('reconciles a failed action after its form was closed without leaking the error into another user', async () => {
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  await openDashboard();
  await resetUser01ThenOpenUser02();
  // A failed reply is uncertain: the write may have landed, so the next
  // snapshot carries the reset row.
  client.users.mockClear();
  client.users.mockResolvedValue(
    pageOf(
      users.map((row) => (row.userId === 'user-01' ? user01AfterReset : row)),
    ),
  );

  await act(async () =>
    reset.reject(new HttpError('Reset outcome uncertain', 503)),
  );

  expect(client.reset).toHaveBeenCalledTimes(1);
  expect(client.users).toHaveBeenCalledTimes(1);
  expect(tableRow('user-01').getByText('100 / 100')).toBeTruthy();
  expect(screen.getByText(/Used 50; limit 100/)).toBeTruthy();
  expect(screen.queryByText('Reset outcome uncertain')).toBeNull();
});

it('keeps the table working when analytics fails', async () => {
  client.analytics.mockRejectedValue(new Error('analytics unavailable'));
  await openDashboard();
  expect(screen.getByText(/analytics unavailable/)).toBeTruthy();

  receiveUpdate(requestUpdate);
  expect(tableRow('user-01').getByText('87 / 100')).toBeTruthy();
});

it('coalesces the connect refresh behind the mounted analytics load without fetching for events', async () => {
  const mountedLoad = deferred<Analytics>();
  client.analytics.mockReturnValueOnce(mountedLoad.promise);
  await openDashboard();
  expect(client.analytics).toHaveBeenCalledTimes(1);
  const mountedLoadSignal = client.analytics.mock.calls[0][0];
  expect(mountedLoadSignal?.aborted).toBe(false);

  receiveUpdate(requestUpdate);
  expect(client.analytics).toHaveBeenCalledTimes(1);

  await act(async () => mountedLoad.resolve(analytics));
  expect(client.analytics).toHaveBeenCalledTimes(2);

  await advance(TICK_MS - 1);
  expect(client.analytics).toHaveBeenCalledTimes(2);
  expect(screen.getByText('64%')).toBeTruthy();
});

it('announces connection changes without announcing ordinary event or snapshot timestamps', async () => {
  await openDashboard();
  const status = screen.getByRole('status');

  receiveUpdate(requestUpdate);
  expect(status.textContent).toBe('Live');
  expect(
    screen.getByText('Last update 10:42:01 UTC').closest('[role="status"]'),
  ).toBeNull();

  await advance(TICK_MS);
  expect(status.textContent).toBe('Live');
  expect(screen.getByText('Last update 10:42:10 UTC')).toBeTruthy();

  act(() => socket.listeners.disconnect.forEach((listener) => listener()));
  expect(status.textContent).toBe('Disconnected, reconnecting…');

  await connectSocket();
  expect(status.textContent).toBe('Live');
});
