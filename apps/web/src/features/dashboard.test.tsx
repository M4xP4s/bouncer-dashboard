import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { LiveUsers } from '../live/useLiveUsers.ts';
import { NOW, users } from '../fixtures/index.ts';
import { deferred, mockClient } from '../lib/test-helpers.ts';
import { UsersTable } from './table/UsersTable.tsx';
import { filterUsers } from './table/filterUsers.ts';
import { UserDrawer } from './detail/UserDetail.tsx';
import { mergeRequests } from './detail/mergeRequests.ts';
import { AdminForms } from './admin/AdminForms.tsx';
import { AnalyticsCards } from './analytics/AnalyticsCards.tsx';

const now = Date.parse(NOW);
function setup() {
  const controller = new AbortController();
  const client = mockClient();
  const session = {
    token: 'token',
    signal: controller.signal,
    client,
    onRefused: vi.fn(),
  };
  const live: LiveUsers = {
    rows: new Map(users.map((row) => [row.userId, row])),
    liveRecords: new Map(),
    connection: 'live',
    lastUpdateAt: NOW,
    snapshot: { status: 'loaded', error: null },
    now,
    tick: 0,
    applyRow: vi.fn(),
    refresh: vi.fn(),
  };
  return { controller, client, session, live };
}
const wrap = (node: React.ReactNode) =>
  render(<MantineProvider>{node}</MantineProvider>);

it('filters by plain user ID, server status and recent activity', () => {
  expect(
    filterUsers(users, 'USER-04', 'Warning', '300000', now).map(
      (row) => row.userId,
    ),
  ).toEqual(['user-04']);
  expect(
    filterUsers(users, '', 'Exceeded', 'any', now).every(
      (row) => row.status === 'Exceeded',
    ),
  ).toBe(true);
  expect(
    filterUsers(users, '', 'any', '300000', now).every(
      (row) =>
        row.lastRequestAt && Date.parse(row.lastRequestAt) >= now - 300000,
    ),
  ).toBe(true);
});

it('orders user IDs by plain strings regardless of locale collation', () => {
  const mixed = ['user_1', 'user-a', 'user-A', 'user-2'].map((userId) => ({
    ...users[0],
    userId,
  }));
  expect(
    filterUsers(mixed, '', 'any', 'any', now).map((row) => row.userId),
  ).toEqual(['user-2', 'user-A', 'user-a', 'user_1']);
});

it('keeps rows on snapshot failure, provides keyboard buttons and expires suspension', () => {
  const row = {
    ...users[0],
    status: 'Exceeded' as const,
    suspendedUntil: new Date(now - 1).toISOString(),
  };
  const select = vi.fn();
  wrap(
    <UsersTable
      rows={new Map([[row.userId, row]])}
      snapshot={{ status: 'error', error: new Error('offline') }}
      now={now}
      onSelect={select}
    />,
  );
  expect(screen.getByText(/offline/)).toBeTruthy();
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('Exceeded'),
  ).toBeTruthy();
  expect(screen.queryByText(/throttling suspended/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: row.userId }));
  expect(select).toHaveBeenCalledWith(row.userId);
});

it('merges by id, applies strict 24-hour cutoff and sorts ties by id', () => {
  const record = (id: string, at: number) => ({
    id,
    at: new Date(at).toISOString(),
    outcome: 'denied' as const,
    remaining: 0,
  });
  expect(
    mergeRequests(
      [record('a', now - 1), record('old', now - 86400000)],
      [record('b', now - 1), record('a', now - 1)],
      now,
    ).map((r) => r.id),
  ).toEqual(['a', 'b']);
  expect(
    mergeRequests([], [record('only', now - 86400000 + 1)], now),
  ).toHaveLength(1);
  expect(
    mergeRequests([], [record('only', now - 86400000 + 1)], now + 1),
  ).toHaveLength(0);
});

it('keeps action input on failure, refreshes once, and submits an edited new value', async () => {
  const { session, live, client } = setup();
  client.setLimit
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(users[0]);
  wrap(<AdminForms userId="user-01" session={session} live={live} />);
  const input = screen.getByLabelText('Set limit');
  fireEvent.change(input, { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set limit' }));
  await screen.findByText('offline');
  expect(client.setLimit).toHaveBeenCalledTimes(1);
  expect(live.refresh).toHaveBeenCalledTimes(1);
  expect((input as HTMLInputElement).value).toBe('12');
  fireEvent.change(input, { target: { value: '13' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set limit' }));
  await waitFor(() =>
    expect(client.setLimit).toHaveBeenLastCalledWith('user-01', { limit: 13 }),
  );
  await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(users[0]));
});

it('applies a late action to its original user after selection changes; aborted sessions do nothing', async () => {
  const { session, live, client, controller } = setup();
  const first = deferred<(typeof users)[number]>();
  client.reset.mockReturnValueOnce(first.promise);
  const view = wrap(
    <AdminForms key="a" userId="user-01" session={session} live={live} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  view.rerender(
    <MantineProvider>
      <AdminForms key="b" userId="user-02" session={session} live={live} />
    </MantineProvider>,
  );
  await act(async () => first.resolve(users[0]));
  expect(client.reset).toHaveBeenCalledWith('user-01');
  expect(live.applyRow).toHaveBeenCalledWith(users[0]);
  const second = deferred<(typeof users)[number]>();
  client.reset.mockReturnValueOnce(second.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  controller.abort();
  await act(async () => second.reject(new Error('late')));
  expect(live.refresh).not.toHaveBeenCalled();
  expect(screen.queryByText('late')).toBeNull();
});

it('isolates a history failure from held stats and recent requests and refreshes detail on tick', async () => {
  const { session, live, client } = setup();
  const request = {
    id: 'x',
    at: NOW,
    outcome: 'denied' as const,
    remaining: 0,
  };
  client.detail.mockResolvedValue({ row: users[0], recentRequests: [request] });
  client.history.mockRejectedValue(new Error('chart offline'));
  const view = wrap(
    <UserDrawer
      userId="user-01"
      onClose={() => {}}
      session={session}
      live={live}
    />,
  );
  expect(await screen.findByText(/chart offline/)).toBeTruthy();
  expect(screen.getByText(/Used 12/)).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Recent requests' })).getByText(
      'denied',
    ),
  ).toBeTruthy();
  view.rerender(
    <MantineProvider>
      <UserDrawer
        userId="user-01"
        onClose={() => {}}
        session={session}
        live={{ ...live, tick: 1 }}
      />
    </MantineProvider>,
  );
  await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
});

it('rejects empty and out-of-range input without sending an action', () => {
  const { session, live, client } = setup();
  wrap(<AdminForms userId="user-01" session={session} live={live} />);
  fireEvent.click(screen.getByRole('button', { name: 'Set limit' }));
  expect(screen.getByText(/integer from 1 to 10000/)).toBeTruthy();
  expect(client.setLimit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Extra requests'), {
    target: { value: '10001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add extra' }));
  expect(client.addExtra).not.toHaveBeenCalled();
});

it('ignores a successful action after the session aborts', async () => {
  const { session, live, client, controller } = setup();
  const response = deferred<(typeof users)[number]>();
  client.reset.mockReturnValue(response.promise);
  wrap(<AdminForms userId="user-01" session={session} live={live} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  controller.abort();
  await act(async () => response.resolve(users[0]));
  expect(live.applyRow).not.toHaveBeenCalled();
  expect(live.refresh).not.toHaveBeenCalled();
});

it('discards an old detail response on a user switch', async () => {
  const { session, live, client } = setup();
  const old = deferred<{ row: (typeof users)[number]; recentRequests: [] }>();
  client.detail
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ row: users[1], recentRequests: [] });
  client.history.mockResolvedValue([]);
  const view = wrap(
    <UserDrawer
      userId="user-01"
      onClose={() => {}}
      session={session}
      live={live}
    />,
  );
  view.rerender(
    <MantineProvider>
      <UserDrawer
        userId="user-02"
        onClose={() => {}}
        session={session}
        live={live}
      />
    </MantineProvider>,
  );
  await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(users[1]));
  await act(async () => old.resolve({ row: users[0], recentRequests: [] }));
  expect(live.applyRow).not.toHaveBeenCalledWith(users[0]);
  expect(screen.getByText(/Used 50/)).toBeTruthy();
});

it('retains a live request during detail refresh and displays later rejections', async () => {
  const { session, live, client } = setup();
  const first = {
    id: 'first',
    at: NOW,
    outcome: 'allowed' as const,
    remaining: 1,
  };
  const second = {
    id: 'second',
    at: NOW,
    outcome: 'denied' as const,
    remaining: 0,
  };
  live.liveRecords = new Map([['user-01', [first]]]);
  client.detail
    .mockResolvedValueOnce({ row: users[0], recentRequests: [] })
    .mockResolvedValueOnce({ row: users[0], recentRequests: [first, second] });
  client.history.mockRejectedValue(new Error('history unavailable'));
  const view = wrap(
    <UserDrawer
      userId="user-01"
      onClose={() => {}}
      session={session}
      live={live}
    />,
  );
  const region = screen.getByRole('region', { name: 'Recent requests' });
  await waitFor(() => expect(within(region).getByText('allowed')).toBeTruthy());
  view.rerender(
    <MantineProvider>
      <UserDrawer
        userId="user-01"
        onClose={() => {}}
        session={session}
        live={{ ...live, tick: 1 }}
      />
    </MantineProvider>,
  );
  await waitFor(() => expect(within(region).getByText('denied')).toBeTruthy());
  expect(within(region).getAllByText('allowed')).toHaveLength(1);
});

it('shows analytics values and their definitions', async () => {
  const { session, client } = setup();
  client.analytics.mockResolvedValue({
    totalUsers: 12,
    activeUsers: 4,
    nearLimitPercent: 50,
    denied429Today: 3,
    day: '2026-11-16',
    topUsers: [{ userId: 'user-06', used: 100, total: 100 }],
  });
  wrap(<AnalyticsCards session={session} tick={0} />);
  expect(await screen.findByText('50%')).toBeTruthy();
  expect(screen.getByText(/share at 90%/)).toBeTruthy();
  expect(screen.getByText(/429 responses today \(UTC\)/)).toBeTruthy();
  expect(screen.getByText(/By requests this hour/)).toBeTruthy();
  expect(screen.getByText('user-06: 100 / 100')).toBeTruthy();
});

it.each([
  ['Set limit', 'Set limit', 'setLimit', '0'],
  ['Set limit', 'Set limit', 'setLimit', '10001'],
  ['Set limit', 'Set limit', 'setLimit', '1.5'],
  ['Suspend minutes', 'Suspend', 'suspend', '0'],
  ['Suspend minutes', 'Suspend', 'suspend', '1441'],
  ['Suspend minutes', 'Suspend', 'suspend', '1.5'],
  ['Extra requests', 'Add extra', 'addExtra', '0'],
  ['Extra requests', 'Add extra', 'addExtra', '10001'],
  ['Extra requests', 'Add extra', 'addExtra', '1.5'],
] as const)(
  'rejects %s value %s after blur',
  (label, button, method, value) => {
    const { session, live, client } = setup();
    wrap(<AdminForms userId="user-01" session={session} live={live} />);
    const input = screen.getByLabelText(label) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(input.value).toBe(value);
    expect(screen.getByRole('alert').textContent).toContain('Enter an integer');
    expect(client[method]).not.toHaveBeenCalled();
  },
);
