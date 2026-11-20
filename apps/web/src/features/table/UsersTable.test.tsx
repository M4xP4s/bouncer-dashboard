// Through the fixture client: a control wired to the wrong field or a page
// number off by one passes the filter function tests but fails here.
import { type ComponentProps, useEffect, useState } from 'react';
import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { UserRow, UsersPage, UsersQuery } from '@app/contracts';
import { createClient } from '../../api/fixture-client.ts';
import { DEFAULT_USERS_QUERY } from '../../api/usersQuery.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { NOW, users } from '../../fixtures/index.ts';
import { deferred, mockClient, pageOf } from '../../lib/test-helpers.ts';
import { UsersTable } from './UsersTable.tsx';

const now = Date.parse(NOW);

afterEach(() => vi.restoreAllMocks());
const user04 = users[3];
const user05 = users[4];
const user09 = users[8];
const FIXTURE_COUNTS = {
  all: 12,
  byStatus: { OK: 5, Warning: 4, Exceeded: 3 },
};

function shownUserIds() {
  return screen
    .queryAllByRole('button', { name: /^user-/ })
    .map((button) => button.textContent);
}

/** A session whose client is mocked, and a live state that records calls. */
function actionContext() {
  const client = mockClient();
  const session = {
    token: 'token',
    signal: new AbortController().signal,
    client,
    onRefused: vi.fn(),
  };
  const live: LiveUsers = {
    rows: new Map(),
    page: null,
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
  return { client, session, live };
}

/** The table with the fixture client answering each query it asks for. */
function TableWithServer({
  initialQuery,
  counts,
  onQueryAsked,
}: {
  initialQuery: UsersQuery;
  counts?: ComponentProps<typeof UsersTable>['counts'];
  onQueryAsked?: (query: UsersQuery) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState<UsersPage | null>(null);
  const [{ session, live }] = useState(actionContext);
  useEffect(() => {
    onQueryAsked?.(query);
    const controller = new AbortController();
    const client = createClient({
      token: 'demo',
      signal: controller.signal,
      onRefused: vi.fn(),
    });
    // A replaced query aborts its read; any other failure must fail the test.
    client.users(query).then(setPage, (error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    return () => controller.abort();
  }, [query, onQueryAsked]);
  return (
    <UsersTable
      rows={new Map()}
      page={page}
      query={query}
      onQuery={setQuery}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
      counts={counts}
      session={session}
      live={live}
    />
  );
}

function renderTable(
  initialQuery = DEFAULT_USERS_QUERY,
  props: Omit<ComponentProps<typeof TableWithServer>, 'initialQuery'> = {},
) {
  render(<TableWithServer initialQuery={initialQuery} {...props} />, {
    wrapper: MantineProvider,
  });
}

/** The table showing `pageRows` in that order, with `heldRows` held. */
function renderRows(
  pageRowsInOrder: UserRow[],
  heldRows: UserRow[] = pageRowsInOrder,
) {
  const context = actionContext();
  const onSelect = vi.fn();
  const table = (held: UserRow[]) => (
    <UsersTable
      rows={new Map(held.map((row) => [row.userId, row]))}
      page={pageOf(pageRowsInOrder)}
      query={DEFAULT_USERS_QUERY}
      onQuery={vi.fn()}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={onSelect}
      counts={FIXTURE_COUNTS}
      session={context.session}
      live={context.live}
    />
  );
  const view = render(table(heldRows), { wrapper: MantineProvider });
  const rerenderHeld = (held: UserRow[]) => view.rerender(table(held));
  return { ...context, onSelect, rerenderHeld };
}

// jsdom has no layout, so once Mantine has measured the field it hides the
// dropdown as detached; the options are still there to click.
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, hidden: true }));
}

const chooseStatus = (option: string) =>
  fireEvent.click(screen.getByRole('radio', { name: option }));

const press = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));

const isDisabled = (name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name }).disabled;

const tableRow = (userId: string) =>
  screen.getByRole('row', { name: new RegExp(userId) });

it('Search user ID leaves only the IDs that contain the text', async () => {
  renderTable();
  fireEvent.change(screen.getByLabelText('Search user ID'), {
    target: { value: 'user-1' },
  });
  await waitFor(() =>
    expect(shownUserIds()).toEqual(['user-11', 'user-10', 'user-12']),
  );
});

it.each([
  ['OK', ['user-03', 'user-02', 'user-01', 'user-10', 'user-12']],
  ['Exceeded', ['user-11', 'user-09', 'user-06']],
] as const)(
  'Status "%s" leaves only the matching rows',
  async (option, expected) => {
    renderTable();
    await screen.findByText('Page 1 of 1 · 12 matching users');
    chooseStatus(option);
    await waitFor(() => expect(shownUserIds()).toEqual(expected));
  },
);

it('Last active "Last 5 minutes" leaves only the matching rows', async () => {
  renderTable();
  await screen.findByText('Page 1 of 1 · 12 matching users');
  choose('Last active', 'Last 5 minutes');
  await waitFor(() =>
    expect(shownUserIds()).toEqual([
      'user-09',
      'user-06',
      'user-05',
      'user-08',
      'user-04',
      'user-07',
      'user-03',
      'user-02',
      'user-01',
    ]),
  );
});

it('a filter starts again at page 1', async () => {
  renderTable({ ...DEFAULT_USERS_QUERY, page: 2, pageSize: 5 });
  await screen.findByText('Page 2 of 3 · 12 matching users');

  chooseStatus('Exceeded');

  await screen.findByText('Page 1 of 1 · 3 matching users');
  expect(shownUserIds()).toEqual(['user-11', 'user-09', 'user-06']);
});

it('Status is one choice with each number of users from the analytics read', () => {
  renderTable(DEFAULT_USERS_QUERY, { counts: FIXTURE_COUNTS });

  const status = within(screen.getByRole('radiogroup', { name: 'Status' }));
  expect(
    status
      .getAllByRole<HTMLInputElement>('radio')
      .map((radio) => radio.labels?.[0]?.textContent),
  ).toEqual(['All 12', 'Exceeded 3', 'Warning 4', 'OK 5']);
  expect(
    status.getByRole<HTMLInputElement>('radio', { name: 'All 12' }).checked,
  ).toBe(true);
  expect(status.getAllByRole('radio', { checked: true })).toHaveLength(1);
});

it('Status shows no number while analytics is missing, and still filters', async () => {
  renderTable();

  const status = within(screen.getByRole('radiogroup', { name: 'Status' }));
  expect(
    status
      .getAllByRole<HTMLInputElement>('radio')
      .map((radio) => radio.labels?.[0]?.textContent),
  ).toEqual(['All', 'Exceeded', 'Warning', 'OK']);

  await screen.findByText('Page 1 of 1 · 12 matching users');
  chooseStatus('Warning');
  await screen.findByText('Page 1 of 1 · 4 matching users');
});

it('asks for "Closest to limit" first and "User ID" on choice, either from page 1', async () => {
  const asked = vi.fn();
  renderTable(
    { ...DEFAULT_USERS_QUERY, page: 2, pageSize: 5 },
    { onQueryAsked: asked },
  );
  await screen.findByText('Page 2 of 3 · 12 matching users');
  expect(asked).toHaveBeenLastCalledWith(
    expect.objectContaining({ sort: 'closest', page: 2 }),
  );
  expect(
    screen.getByRole<HTMLInputElement>('combobox', { name: 'Sort' }).value,
  ).toBe('Closest to limit');

  choose('Sort', 'User ID');

  await screen.findByText('Page 1 of 3 · 12 matching users');
  expect(asked).toHaveBeenLastCalledWith(
    expect.objectContaining({ sort: 'id', page: 1 }),
  );
  expect(shownUserIds()).toEqual([
    'user-01',
    'user-02',
    'user-03',
    'user-04',
    'user-05',
  ]);

  press('Next page');
  await screen.findByText('Page 2 of 3 · 12 matching users');
  choose('Sort', 'Closest to limit');
  await screen.findByText('Page 1 of 3 · 12 matching users');
  expect(shownUserIds()).toEqual([
    'user-11',
    'user-09',
    'user-06',
    'user-05',
    'user-08',
  ]);
});

it('the page buttons and Users per page ask for their page', async () => {
  renderTable({ ...DEFAULT_USERS_QUERY, pageSize: 5 });
  await screen.findByText('Page 1 of 3 · 12 matching users');
  expect(isDisabled('Previous page')).toBe(true);
  expect(screen.getByTitle('Previous page')).toBeTruthy();
  expect(screen.getByTitle('Next page')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'First page' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Last page' })).toBeNull();

  press('Next page');
  await screen.findByText('Page 2 of 3 · 12 matching users');
  expect(shownUserIds()).toEqual([
    'user-04',
    'user-07',
    'user-03',
    'user-02',
    'user-01',
  ]);

  press('Next page');
  await screen.findByText('Page 3 of 3 · 12 matching users');
  expect(shownUserIds()).toEqual(['user-10', 'user-12']);
  expect(isDisabled('Next page')).toBe(true);
  expect(screen.getByText('Updated 10:42:00 UTC')).toBeTruthy();

  press('Previous page');
  await screen.findByText('Page 2 of 3 · 12 matching users');

  choose('Users per page', '25');
  await screen.findByText('Page 1 of 1 · 12 matching users');
  expect(shownUserIds()).toHaveLength(12);
});

it('returns to page 1 when a refresh leaves the page past the last', () => {
  const onQuery = vi.fn();
  const query = { ...DEFAULT_USERS_QUERY, page: 3, pageSize: 5 };
  const { session, live } = actionContext();
  render(
    <UsersTable
      rows={new Map()}
      page={pageOf([], { page: 3, pageSize: 5, total: 10 })}
      query={query}
      onQuery={onQuery}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
      counts={undefined}
      session={session}
      live={live}
    />,
    { wrapper: MantineProvider },
  );

  expect(onQuery).toHaveBeenCalledExactlyOnceWith({ ...query, page: 1 });
  expect(screen.getByText('No users match the filters.')).toBeTruthy();
});

it('shows the held row of a user on the page, not the page copy', () => {
  const newer = { ...users[0], remaining: 7, version: users[0].version + 1 };
  renderRows([users[0]], [newer]);

  expect(screen.getByText(`7 / ${newer.total}`)).toBeTruthy();
});

it('an event leaves a row in its place', () => {
  const { rerenderHeld } = renderRows([user05, user04, users[0]]);
  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);

  // user-01 now holds the most used share, and still stands last.
  const user01AtLimit: UserRow = {
    ...users[0],
    used: 100,
    remaining: 0,
    status: 'Exceeded',
    version: 100,
  };
  rerenderHeld([user05, user04, user01AtLimit]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  expect(within(tableRow('user-01')).getByText('0 / 100')).toBeTruthy();
});

it('puts the row controls on Warning and Exceeded rows only, by their live status', () => {
  const user05NowOk: UserRow = {
    ...user05,
    used: 10,
    remaining: 90,
    status: 'OK',
    version: user05.version + 1,
  };
  renderRows(users, [...users.filter((row) => row !== user05), user05NowOk]);

  const withControls = screen
    .getAllByRole('button', { name: /^Reset usage of / })
    .map((button) => button.getAttribute('aria-label'));
  expect(withControls).toEqual([
    'Reset usage of user-04',
    'Reset usage of user-06',
    'Reset usage of user-07',
    'Reset usage of user-08',
    'Reset usage of user-09',
    'Reset usage of user-11',
  ]);
  expect(
    screen.getAllByRole('button', { name: /^Add extra to / }),
  ).toHaveLength(6);
  expect(
    within(tableRow('user-01')).queryByRole('button', { name: /Reset usage/ }),
  ).toBeNull();
  expect(
    screen.getAllByRole('columnheader').map((th) => th.textContent),
  ).toEqual([
    'User ID',
    'Remaining / Total',
    'Reset Time',
    'Status',
    'Last Request',
    'Actions',
  ]);
});

it("a row's Add extra sends 50 for that user, then closes its field", async () => {
  const { client, live } = renderRows([user05, user04]);
  client.addExtra.mockResolvedValue(user05);

  press('Add extra to user-05');
  const field =
    await screen.findByLabelText<HTMLInputElement>('Extra requests');
  expect(field.value).toBe('50');
  press('Add extra');

  await waitFor(() =>
    expect(client.addExtra).toHaveBeenCalledExactlyOnceWith('user-05', {
      amount: 50,
    }),
  );
  await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(user05));
  await waitFor(() =>
    expect(screen.queryByLabelText('Extra requests')).toBeNull(),
  );
});

it("a row's Add extra sends the number typed for that user", async () => {
  const { client } = renderRows([user05, user04]);
  client.addExtra.mockResolvedValue(user04);

  press('Add extra to user-04');
  fireEvent.change(await screen.findByLabelText('Extra requests'), {
    target: { value: '75' },
  });
  press('Add extra');

  await waitFor(() =>
    expect(client.addExtra).toHaveBeenCalledExactlyOnceWith('user-04', {
      amount: 75,
    }),
  );
});

it('an invalid number in the row field names the user and sends nothing', async () => {
  const { client } = renderRows([user05]);

  press('Add extra to user-05');
  fireEvent.change(await screen.findByLabelText('Extra requests'), {
    target: { value: '1.5' },
  });
  press('Add extra');

  expect(screen.getByRole('alert').textContent).toBe(
    'user-05: Enter an integer from 1 to 10000.',
  );
  expect(client.addExtra).not.toHaveBeenCalled();
});

it('a failed row action shows its error with the user ID, once sent, until the next one starts', async () => {
  const { client, live } = renderRows([user05, user04]);
  const secondReset = deferred<UserRow>();
  client.reset
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(secondReset.promise);

  press('Reset usage of user-05');

  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('user-05: offline'),
  );
  expect(client.reset).toHaveBeenCalledExactlyOnceWith('user-05');
  expect(live.refresh).toHaveBeenCalledOnce();

  press('Reset usage of user-04');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => secondReset.resolve(user04));
});

it('Dismiss closes the row error and sends nothing', async () => {
  const { client, live } = renderRows([user05, user04]);
  client.reset.mockRejectedValueOnce(new Error('offline'));
  press('Reset usage of user-05');
  await screen.findByRole('alert');

  press('Dismiss');

  expect(screen.queryByRole('alert')).toBeNull();
  expect(client.reset).toHaveBeenCalledOnce();
  expect(client.addExtra).not.toHaveBeenCalled();
  expect(live.refresh).toHaveBeenCalledOnce();
});

it('a click on a row focuses its ID button without scrolling the page', () => {
  renderRows([user05]);
  const idButton = screen.getByRole('button', { name: 'user-05' });
  const focus = vi.spyOn(idButton, 'focus');

  fireEvent.click(within(tableRow('user-05')).getByText('1 / 100'));

  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
});

it('the table runs one row action at a time', async () => {
  const { client } = renderRows([user05, user04]);
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);

  press('Reset usage of user-05');

  expect(isDisabled('Reset usage of user-04')).toBe(true);
  press('Reset usage of user-04');
  expect(client.reset).toHaveBeenCalledOnce();

  await act(async () => reset.resolve(user05));
  expect(isDisabled('Reset usage of user-04')).toBe(false);
});

it('keeps an open Extra requests field when its row turns OK', async () => {
  const { rerenderHeld } = renderRows([user05]);
  press('Add extra to user-05');
  await screen.findByLabelText('Extra requests');

  rerenderHeld([
    { ...user05, used: 10, remaining: 90, status: 'OK', version: 200 },
  ]);

  expect(screen.getByLabelText('Extra requests')).toBeTruthy();
  expect(within(tableRow('user-05')).getByText('OK')).toBeTruthy();
});

it('a click on a row opens its panel; a click on its controls does not', async () => {
  const { onSelect } = renderRows([user05]);

  press('Reset usage of user-05');
  press('Add extra to user-05');
  fireEvent.click(await screen.findByLabelText('Extra requests'));
  expect(onSelect).not.toHaveBeenCalled();

  fireEvent.click(within(tableRow('user-05')).getByText('1 / 100'));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('user-05');

  press('user-05');
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith('user-05');
});

it('a click on the empty Actions cell of an OK row opens its panel', () => {
  const user01 = users[0];
  const { onSelect } = renderRows([user01]);

  const cells = within(tableRow('user-01')).getAllByRole('cell');
  fireEvent.click(cells[cells.length - 1]!);

  expect(onSelect).toHaveBeenCalledExactlyOnceWith('user-01');
});

it('Escape in the open row field returns focus to its Add extra button', async () => {
  renderRows([user05]);
  const addExtra = screen.getByRole('button', { name: 'Add extra to user-05' });
  addExtra.focus();
  fireEvent.click(addExtra);
  const field = await screen.findByLabelText('Extra requests');

  fireEvent.keyDown(field, { key: 'Escape' });

  await waitFor(() =>
    expect(screen.queryByLabelText('Extra requests')).toBeNull(),
  );
  expect(document.activeElement).toBe(addExtra);
});

it('after a row action that turns the row OK, focus is on its ID button', async () => {
  const { client, rerenderHeld } = renderRows([user05]);
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  const user05AfterReset: UserRow = {
    ...user05,
    used: 0,
    remaining: 100,
    status: 'OK',
    version: user05.version + 1,
  };
  const resetButton = screen.getByRole('button', {
    name: 'Reset usage of user-05',
  });
  resetButton.focus();
  fireEvent.click(resetButton);

  await act(async () => {
    rerenderHeld([user05AfterReset]);
    reset.resolve(user05AfterReset);
  });

  expect(screen.queryByRole('button', { name: /Reset usage/ })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'user-05' }),
  );
});

it('after an Add extra that closes the field, focus is on its Add extra button', async () => {
  const { client } = renderRows([user05]);
  client.addExtra.mockResolvedValue(user05);
  const addExtra = screen.getByRole('button', { name: 'Add extra to user-05' });
  addExtra.focus();
  fireEvent.click(addExtra);
  await screen.findByLabelText('Extra requests');
  const submit = screen.getByRole('button', { name: 'Add extra' });
  submit.focus();
  fireEvent.click(submit);
  // A browser drops focus from a button as it is disabled.
  submit.blur();

  await waitFor(() =>
    expect(screen.queryByLabelText('Extra requests')).toBeNull(),
  );
  expect(document.activeElement).toBe(addExtra);
});

it('after an Add extra that turns the row OK, focus is on its ID button', async () => {
  const { client, rerenderHeld } = renderRows([user05]);
  const addExtraReply = deferred<UserRow>();
  client.addExtra.mockReturnValue(addExtraReply.promise);
  const user05WithExtra: UserRow = {
    ...user05,
    extra: 50,
    total: 150,
    remaining: 50,
    status: 'OK',
    version: user05.version + 1,
  };
  press('Add extra to user-05');
  await screen.findByLabelText('Extra requests');
  const submit = screen.getByRole('button', { name: 'Add extra' });
  submit.focus();
  fireEvent.click(submit);

  await act(async () => {
    rerenderHeld([user05WithExtra]);
    addExtraReply.resolve(user05WithExtra);
  });

  expect(screen.queryByLabelText('Extra requests')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'user-05' }),
  );
});

it('after a failed row action, focus left on the page returns to the pressed button', async () => {
  const { client } = renderRows([user05]);
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  const resetButton = screen.getByRole('button', {
    name: 'Reset usage of user-05',
  });
  resetButton.focus();
  fireEvent.click(resetButton);
  // A browser drops focus from a button as it is disabled.
  resetButton.blur();

  await act(async () => reset.reject(new Error('offline')));

  expect(document.activeElement).toBe(resetButton);
});

it('after a row action, focus the admin moved elsewhere stays there', async () => {
  const { client } = renderRows([user05]);
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  press('Reset usage of user-05');
  const search = screen.getByRole('textbox', { name: 'Search user ID' });
  search.focus();

  await act(async () => reset.reject(new Error('offline')));

  expect(document.activeElement).toBe(search);
});

it('keeps the row error in view and marks the field it is for', async () => {
  renderRows([user05]);

  press('Add extra to user-05');
  const field = await screen.findByLabelText('Extra requests');
  fireEvent.change(field, { target: { value: '0' } });
  press('Add extra');

  expect(screen.getByRole('alert').style.position).toBe('sticky');
  expect(field.getAttribute('aria-invalid')).toBe('true');
});

/** The table showing a page read for `query`; `showPage` stands for the next read. */
function renderPage(firstRows: UserRow[]) {
  const context = actionContext();
  const table = (
    pageRowsInOrder: UserRow[],
    query: UsersQuery,
    held: UserRow[],
  ) => (
    <UsersTable
      rows={new Map(held.map((row) => [row.userId, row]))}
      page={pageOf(pageRowsInOrder)}
      query={query}
      onQuery={vi.fn()}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
      counts={FIXTURE_COUNTS}
      session={context.session}
      live={context.live}
    />
  );
  const view = render(table(firstRows, DEFAULT_USERS_QUERY, []), {
    wrapper: MantineProvider,
  });
  /** A page read; `held` are rows the live session holds beside the page's. */
  const showPage = (
    next: UserRow[],
    query = DEFAULT_USERS_QUERY,
    held: UserRow[] = [],
  ) => view.rerender(table(next, query, held));
  return { ...context, showPage };
}

// The head and the body are the table's two row groups.
const tableBody = () => screen.getAllByRole('rowgroup')[1];
const user01 = users[0];
const user04Closer: UserRow = {
  ...user04,
  used: 100,
  remaining: 0,
  status: 'Exceeded',
  version: user04.version + 1,
};

it('a new page shows in its own order at once while the table is not held', () => {
  const { showPage } = renderPage([user05, user04, user01]);

  showPage([user04Closer, user05, user01]);

  expect(shownUserIds()).toEqual(['user-04', 'user-05', 'user-01']);
});

it('with the pointer over the rows, a new page keeps their places with its values until it leaves', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  fireEvent.pointerOver(tableRow('user-04'));

  showPage([user04Closer, user05, user01]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  expect(within(tableRow('user-04')).getByText('0 / 100')).toBeTruthy();
  fireEvent.pointerLeave(tableBody());
  expect(shownUserIds()).toEqual(['user-04', 'user-05', 'user-01']);
});

it('with focus in a row, a new page keeps the places until focus leaves', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  const reset = screen.getByRole('button', { name: 'Reset usage of user-05' });
  act(() => reset.focus());

  showPage([user04Closer, user05, user01]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  act(() => reset.blur());
  expect(shownUserIds()).toEqual(['user-04', 'user-05', 'user-01']);
});

it('with the pointer over the rows, a row whose user left the page stays, so each control keeps its place', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  fireEvent.pointerOver(tableRow('user-04'));

  showPage([user04, user01]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  fireEvent.pointerLeave(tableBody());
  expect(shownUserIds()).toEqual(['user-04', 'user-01']);
});

it('with focus in a row whose user leaves the page, the row stays until focus leaves', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  const reset = screen.getByRole('button', { name: 'Reset usage of user-05' });
  act(() => reset.focus());

  showPage([user04, user01]);
  showPage([user01, user04Closer]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  expect(document.activeElement).toBe(reset);
  act(() => reset.blur());
  expect(shownUserIds()).toEqual(['user-01', 'user-04']);
});

it('a held row whose user left the page shows the newest row held for that user', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  fireEvent.pointerOver(tableRow('user-04'));
  const user05Granted: UserRow = {
    ...user05,
    total: 150,
    remaining: 50,
    status: 'OK',
    version: user05.version + 1,
  };

  showPage([user04, user01], DEFAULT_USERS_QUERY, [user05Granted]);

  expect(within(tableRow('user-05')).getByText('50 / 150')).toBeTruthy();
});

it('names the users it holds to the live session, and none once the hold ends', () => {
  const { live } = renderPage([user05, user04, user01]);

  fireEvent.pointerOver(tableRow('user-04'));
  expect(live.keep).toHaveBeenLastCalledWith(['user-05', 'user-04', 'user-01']);

  fireEvent.pointerLeave(tableBody());
  expect(live.keep).toHaveBeenLastCalledWith([]);
});

it('focus moving to another control of the table keeps the hold', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  const reset = screen.getByRole('button', { name: 'Reset usage of user-05' });
  act(() => reset.focus());
  showPage([user04Closer, user05, user01]);

  fireEvent.blur(reset, {
    relatedTarget: screen.getByRole('button', { name: 'user-04' }),
  });

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
});

it('focus that is not keyboard focus, as after a row click, does not hold', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  const idButton = screen.getByRole('button', { name: 'user-05' });
  const matches = idButton.matches.bind(idButton);
  vi.spyOn(idButton, 'matches').mockImplementation(
    (selector) => selector !== ':focus-visible' && matches(selector),
  );
  act(() => idButton.focus());

  showPage([user04Closer, user05, user01]);

  expect(shownUserIds()).toEqual(['user-04', 'user-05', 'user-01']);
});

it('keeps a row with an open field the new page no longer lists, until the field closes', async () => {
  const { showPage } = renderPage([user05, user04, user01]);
  press('Add extra to user-05');
  const field = await screen.findByLabelText('Extra requests');

  showPage([user01, user04Closer]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  expect(screen.getByLabelText('Extra requests')).toBe(field);
  fireEvent.keyDown(field, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByLabelText('Extra requests')).toBeNull(),
  );
  expect(shownUserIds()).not.toContain('user-05');
});

it('a user new to the page shows when the hold ends, not during it', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  fireEvent.pointerOver(tableRow('user-04'));

  showPage([user09, user04, user05]);

  expect(shownUserIds()).toEqual(['user-05', 'user-04', 'user-01']);
  fireEvent.pointerLeave(tableBody());
  expect(shownUserIds()).toEqual(['user-09', 'user-04', 'user-05']);
});

it("an open field reads its user's detail at once and on every tick, applies its row and keeps the number typed", async () => {
  const { client, live, rerenderHeld } = renderRows([user05, user04]);
  const user05Granted: UserRow = { ...user05, total: 150, remaining: 50 };
  client.detail.mockResolvedValue({ row: user05Granted, recentRequests: [] });

  press('Add extra to user-05');
  const field =
    await screen.findByLabelText<HTMLInputElement>('Extra requests');
  fireEvent.change(field, { target: { value: '17' } });
  await waitFor(() =>
    expect(live.applyDetailRow).toHaveBeenCalledWith(user05Granted),
  );
  expect(client.detail).toHaveBeenCalledExactlyOnceWith(
    'user-05',
    expect.any(AbortSignal),
  );

  live.tick = 1;
  rerenderHeld([user05Granted, user04]);

  await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
  expect(within(tableRow('user-05')).getByText('50 / 150')).toBeTruthy();
  expect(field.value).toBe('17');
});

it('a row whose field is closed reads no detail', () => {
  const { client, live, rerenderHeld } = renderRows([user05, user04]);

  live.tick = 1;
  rerenderHeld([user05, user04]);

  expect(client.detail).not.toHaveBeenCalled();
});

it('a change of sort shows the new page in its own order under the pointer', () => {
  const { showPage } = renderPage([user05, user04, user01]);
  fireEvent.pointerOver(tableRow('user-04'));

  showPage([user01, user04, user05], { ...DEFAULT_USERS_QUERY, sort: 'id' });

  expect(shownUserIds()).toEqual(['user-01', 'user-04', 'user-05']);
});

it('wraps a 64-character ID in its row, and keeps the badge and the times whole', () => {
  const longId =
    'tenant-with-a-long-identifier-from-an-upstream-system-0000000001';
  renderRows([{ ...user05, userId: longId }]);

  const idButton = screen.getByRole('button', { name: longId });
  expect(idButton.textContent).toBe(longId);
  const label = idButton.querySelector<HTMLElement>('.mantine-Button-label');
  expect(label?.style.whiteSpace).toBe('normal');
  expect(label?.style.overflowWrap).toBe('anywhere');
  const row = within(tableRow(longId));
  const badge = row
    .getByText('Warning')
    .closest<HTMLElement>('.mantine-Badge-root');
  expect(badge?.style.minWidth).toBe('max-content');
  expect(badge?.getAttribute('data-truncate')).toBeNull();
  const cells = row.getAllByRole('cell');
  for (const index of [1, 2, 4]) {
    expect(cells[index]?.style.whiteSpace).toBe('nowrap');
  }
});

it('draws a used share above the total as a full bar, not a wider one', () => {
  renderRows([user09]);

  const bar = within(tableRow('user-09')).getByRole('progressbar', {
    hidden: true,
  });
  expect(bar.getAttribute('aria-valuenow')).toBe('100');
  expect(within(tableRow('user-09')).getByText('0 / 100')).toBeTruthy();
});
