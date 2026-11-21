import type { ReactNode } from 'react';
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
import type {
  Analytics,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';
import type { LiveUsers } from '../live/useLiveUsers.ts';
import { NOW, users } from '../fixtures/index.ts';
import { DEFAULT_USERS_QUERY } from '../api/usersQuery.ts';
import { deferred, mockClient, pageOf } from '../lib/test-helpers.ts';
import type { Session } from '../api/useSession.ts';
import { useRequest } from '../lib/useRequest.ts';
import { UsersTable } from './table/UsersTable.tsx';
import { UserDrawer } from './detail/UserDetail.tsx';
import { mergeRequests } from './detail/mergeRequests.ts';
import { AdminForms } from './admin/AdminForms.tsx';
import { AnalyticsCards } from './analytics/AnalyticsCards.tsx';

const now = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

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
    page: pageOf(users),
    liveRecords: new Map(),
    connection: 'live',
    lastUpdateAt: NOW,
    snapshot: { status: 'loaded', error: null },
    now,
    tick: 0,
    applyRow: vi.fn(),
    applyDetailRow: vi.fn(),
    keep: vi.fn(),
    refresh: vi.fn(),
  };
  // Keyed like the drawer's content: another user gets a fresh form.
  const adminForms = (userId: string) => (
    <AdminForms key={userId} userId={userId} session={session} live={live} />
  );
  const userDrawer = (userId: string, liveChanges: Partial<LiveUsers> = {}) => (
    <UserDrawer
      userId={userId}
      onClose={() => {}}
      session={session}
      live={{ ...live, ...liveChanges }}
    />
  );
  return { controller, client, session, live, adminForms, userDrawer };
}

// The wrapper also applies to rerender(), so a test passes only its component.
const renderInMantine = (node: ReactNode) =>
  render(node, { wrapper: MantineProvider });

const press = (button: string) =>
  fireEvent.click(screen.getByRole('button', { name: button }));

const enter = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const recentRequests = () =>
  within(screen.getByRole('region', { name: 'Recent requests' }));

/** The value a labelled entry of the user stats holds. */
const statValue = async (label: string) => {
  const stats = within(
    await screen.findByRole('region', { name: 'User stats' }),
  );
  return stats.getByText(label, { selector: 'dt' }).nextElementSibling
    ?.textContent;
};

function requestRecord(changes: Partial<RequestRecord>): RequestRecord {
  return { id: 'x', at: NOW, outcome: 'denied', remaining: 0, ...changes };
}

it('keeps rows on snapshot failure, provides keyboard buttons and expires suspension', () => {
  const suspensionJustExpired: UserRow = {
    ...users[0],
    status: 'Exceeded',
    suspendedUntil: new Date(now - 1).toISOString(),
  };
  const onSelect = vi.fn();
  const { session, live } = setup();
  renderInMantine(
    <UsersTable
      rows={new Map([['user-01', suspensionJustExpired]])}
      page={pageOf([suspensionJustExpired])}
      query={DEFAULT_USERS_QUERY}
      onQuery={vi.fn()}
      snapshot={{ status: 'error', error: new Error('offline') }}
      now={now}
      onSelect={onSelect}
      counts={undefined}
      session={session}
      live={live}
    />,
  );

  expect(screen.getByText(/offline/)).toBeTruthy();
  expect(
    within(screen.getByRole('row', { name: /user-01/ })).getByText('Exceeded'),
  ).toBeTruthy();
  expect(screen.queryByText(/throttling suspended/i)).toBeNull();

  press('user-01');
  expect(onSelect).toHaveBeenCalledWith('user-01');
});

it('merges by id, applies strict 24-hour cutoff and sorts ties by id', () => {
  const requestAt = (id: string, at: number) =>
    requestRecord({ id, at: new Date(at).toISOString() });
  const justNow = now - 1;
  const aDayAgo = now - DAY_MS;

  const merged = mergeRequests(
    [requestAt('a', justNow), requestAt('old', aDayAgo)],
    [requestAt('b', justNow), requestAt('a', justNow)],
    now,
  );
  expect(merged.map((record) => record.id)).toEqual(['a', 'b']);

  const oneMsInsideTheDay = [requestAt('only', aDayAgo + 1)];
  expect(mergeRequests([], oneMsInsideTheDay, now)).toHaveLength(1);
  expect(mergeRequests([], oneMsInsideTheDay, now + 1)).toHaveLength(0);
});

it('isolates a history failure from held stats and recent requests and refreshes detail on tick', async () => {
  const { client, userDrawer } = setup();
  client.detail.mockResolvedValue({
    row: users[0],
    recentRequests: [requestRecord({ outcome: 'denied' })],
  });
  client.history.mockRejectedValue(new Error('chart offline'));
  const view = renderInMantine(userDrawer('user-01'));

  expect(await screen.findByText(/chart offline/)).toBeTruthy();
  expect(screen.getByText('12 used of 100 · 88 remaining')).toBeTruthy();
  expect(recentRequests().getByText('denied')).toBeTruthy();

  view.rerender(userDrawer('user-01', { tick: 1 }));
  await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
});

it("shows the user's last reset time in the detail panel", async () => {
  const { client, userDrawer } = setup();
  // A manual reset inside the window, so it differs from the window start.
  const resetByAdmin: UserRow = {
    ...users[0],
    lastResetAt: '2026-11-16T10:17:42.000Z',
  };
  client.detail.mockResolvedValue({ row: resetByAdmin, recentRequests: [] });
  client.history.mockResolvedValue([]);
  renderInMantine(
    userDrawer('user-01', { rows: new Map([['user-01', resetByAdmin]]) }),
  );

  expect(await statValue('Last reset')).toBe('10:17:42 UTC');
  expect(await statValue('Reset')).toBe('11:00:00 UTC (18m)');
  expect(await statValue('Suspension')).toBe('Not suspended');
});

it('the controls stand before the history', async () => {
  const { client, userDrawer } = setup();
  client.detail.mockResolvedValue({ row: users[0], recentRequests: [] });
  client.history.mockResolvedValue([]);
  renderInMantine(userDrawer('user-01'));

  await screen.findByText('No recent requests.');
  const inOrder = [
    screen.getByRole('region', { name: 'User stats' }),
    ...['Admin actions', 'History', 'Recent requests'].map((name) =>
      screen.getByRole('heading', { name }),
    ),
  ];
  inOrder.slice(1).forEach((element, index) => {
    const follows =
      inOrder[index].compareDocumentPosition(element) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows).toBeTruthy();
  });
});

it('discards an old detail response on a user switch', async () => {
  const { client, live, userDrawer } = setup();
  const oldDetail = deferred<UserDetail>();
  client.detail
    .mockReturnValueOnce(oldDetail.promise)
    .mockResolvedValueOnce({ row: users[1], recentRequests: [] });
  client.history.mockResolvedValue([]);
  const view = renderInMantine(userDrawer('user-01'));

  view.rerender(userDrawer('user-02'));
  await waitFor(() =>
    expect(live.applyDetailRow).toHaveBeenCalledWith(users[1]),
  );
  await act(async () =>
    oldDetail.resolve({ row: users[0], recentRequests: [] }),
  );

  expect(live.applyDetailRow).not.toHaveBeenCalledWith(users[0]);
  expect(screen.getByText('50 used of 100 · 50 remaining')).toBeTruthy();
});

it('retains a live request during detail refresh and displays later rejections', async () => {
  const { client, live, userDrawer } = setup();
  const first = requestRecord({
    id: 'first',
    outcome: 'allowed',
    remaining: 1,
  });
  const second = requestRecord({ id: 'second', outcome: 'denied' });
  live.liveRecords = new Map([['user-01', [first]]]);
  client.detail
    .mockResolvedValueOnce({ row: users[0], recentRequests: [] })
    .mockResolvedValueOnce({ row: users[0], recentRequests: [first, second] });
  client.history.mockRejectedValue(new Error('history unavailable'));
  const view = renderInMantine(userDrawer('user-01'));
  const requests = recentRequests();
  await waitFor(() => expect(requests.getByText('allowed')).toBeTruthy());

  view.rerender(userDrawer('user-01', { tick: 1 }));

  await waitFor(() => expect(requests.getByText('denied')).toBeTruthy());
  expect(requests.getAllByText('allowed')).toHaveLength(1);
});

it('keeps action input on failure, refreshes once, and submits an edited new value', async () => {
  const { client, live, adminForms } = setup();
  client.setLimit
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(users[0]);
  renderInMantine(adminForms('user-01'));

  enter('Set limit', '12');
  press('Set limit');
  await screen.findByText('offline');
  expect(client.setLimit).toHaveBeenCalledTimes(1);
  expect(live.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText<HTMLInputElement>('Set limit').value).toBe('12');

  enter('Set limit', '13');
  press('Set limit');
  await waitFor(() =>
    expect(client.setLimit).toHaveBeenLastCalledWith('user-01', { limit: 13 }),
  );
  await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(users[0]));
});

it('applies a late action to its original user after selection changes; aborted sessions do nothing', async () => {
  const { client, live, controller, adminForms } = setup();
  const lateReset = deferred<UserRow>();
  client.reset.mockReturnValueOnce(lateReset.promise);
  const view = renderInMantine(adminForms('user-01'));

  press('Reset usage');
  view.rerender(adminForms('user-02'));
  await act(async () => lateReset.resolve(users[0]));
  expect(client.reset).toHaveBeenCalledWith('user-01');
  expect(live.applyRow).toHaveBeenCalledWith(users[0]);

  const resetAfterAbort = deferred<UserRow>();
  client.reset.mockReturnValueOnce(resetAfterAbort.promise);
  press('Reset usage');
  controller.abort();
  await act(async () => resetAfterAbort.reject(new Error('late')));
  expect(live.refresh).not.toHaveBeenCalled();
  expect(screen.queryByText('late')).toBeNull();
});

it('ignores a successful action after the session aborts', async () => {
  const { client, live, controller, adminForms } = setup();
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  renderInMantine(adminForms('user-01'));

  press('Reset usage');
  controller.abort();
  await act(async () => reset.resolve(users[0]));

  expect(live.applyRow).not.toHaveBeenCalled();
  expect(live.refresh).not.toHaveBeenCalled();
});

it('rejects empty and out-of-range input without sending an action', () => {
  const { client, adminForms } = setup();
  renderInMantine(adminForms('user-01'));

  press('Set limit');
  expect(screen.getByText(/integer from 1 to 10000/)).toBeTruthy();
  expect(client.setLimit).not.toHaveBeenCalled();

  enter('Extra requests', '10001');
  press('Add extra');
  expect(client.addExtra).not.toHaveBeenCalled();
});

it.each([
  ['Set limit', '0', 'Set limit', 'setLimit'],
  ['Set limit', '10001', 'Set limit', 'setLimit'],
  ['Set limit', '1.5', 'Set limit', 'setLimit'],
  ['Suspend minutes', '0', 'Suspend', 'suspend'],
  ['Suspend minutes', '1441', 'Suspend', 'suspend'],
  ['Suspend minutes', '1.5', 'Suspend', 'suspend'],
  ['Extra requests', '0', 'Add extra', 'addExtra'],
  ['Extra requests', '10001', 'Add extra', 'addExtra'],
  ['Extra requests', '1.5', 'Add extra', 'addExtra'],
] as const)(
  'rejects %s value %s after blur',
  (label, value, button, method) => {
    const { client, adminForms } = setup();
    renderInMantine(adminForms('user-01'));
    const input = screen.getByLabelText<HTMLInputElement>(label);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    press(button);

    expect(input.value).toBe(value);
    expect(screen.getByRole('alert').textContent).toContain('Enter an integer');
    expect(client[method]).not.toHaveBeenCalled();
  },
);

it('shows analytics values and their definitions', async () => {
  const { client, session } = setup();
  client.analytics.mockResolvedValue({
    startedAt: NOW,
    completedAt: NOW,
    totalUsers: 12,
    activeUsers: 4,
    nearLimitPercent: 50,
    denied429Today: 3,
    day: '2026-11-16',
    topUsers: [{ userId: 'user-06', used: 100, total: 100 }],
    statusCounts: { OK: 8, Warning: 3, Exceeded: 1 },
  });

  renderInMantine(<LoadedAnalytics session={session} />);

  expect(await screen.findByText('50%')).toBeTruthy();
  expect(
    screen.getByText(
      'Of users active this hour, the share at 90% or more of their limit, including exceeded users',
    ),
  ).toBeTruthy();
  expect(screen.getByText('All registered users')).toBeTruthy();
  expect(
    screen.getByText('429 responses today (UTC), 2026-11-16'),
  ).toBeTruthy();
  expect(screen.getByText('By requests this hour')).toBeTruthy();
  const topUser = within(screen.getByRole('listitem'));
  expect(topUser.getByText('user-06')).toBeTruthy();
  expect(topUser.getByText('100 / 100')).toBeTruthy();
  expect(screen.getAllByText('Updated 10:42:00 UTC')).toHaveLength(1);
});

/** Loads analytics as the dashboard does, and shows the cards. */
function LoadedAnalytics({ session }: { session: Session }) {
  const analytics = useRequest<Analytics>(
    'analytics',
    (signal) => session.client.analytics(signal),
    0,
  );
  return <AnalyticsCards analytics={analytics} />;
}
