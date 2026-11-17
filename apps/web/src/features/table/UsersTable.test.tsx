// Through the fixture client: a control wired to the wrong field or a page
// number off by one passes the filter function tests but fails here.
import { useEffect, useState } from 'react';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { UsersPage, UsersQuery } from '@app/contracts';
import { createClient } from '../../api/fixture-client.ts';
import { DEFAULT_USERS_QUERY } from '../../api/usersQuery.ts';
import { NOW, users } from '../../fixtures/index.ts';
import { pageOf } from '../../lib/test-helpers.ts';
import { UsersTable } from './UsersTable.tsx';

const now = Date.parse(NOW);

function shownUserIds() {
  return screen
    .queryAllByRole('button', { name: /^user-/ })
    .map((button) => button.textContent);
}

/** The table with the fixture client answering each query it asks for. */
function TableWithServer({ initialQuery }: { initialQuery: UsersQuery }) {
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState<UsersPage | null>(null);
  useEffect(() => {
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
  }, [query]);
  return (
    <UsersTable
      rows={new Map()}
      page={page}
      query={query}
      onQuery={setQuery}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
    />
  );
}

function renderTable(initialQuery = DEFAULT_USERS_QUERY) {
  render(<TableWithServer initialQuery={initialQuery} />, {
    wrapper: MantineProvider,
  });
}

// jsdom has no layout, so once Mantine has measured the field it hides the
// dropdown as detached; the options are still there to click.
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, hidden: true }));
}

const press = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));

it('Search user ID leaves only the IDs that contain the text', async () => {
  renderTable();
  fireEvent.change(screen.getByLabelText('Search user ID'), {
    target: { value: 'user-1' },
  });
  await waitFor(() =>
    expect(shownUserIds()).toEqual(['user-10', 'user-11', 'user-12']),
  );
});

it.each([
  ['Status', 'OK', ['user-01', 'user-02', 'user-03', 'user-10', 'user-12']],
  ['Status', 'Exceeded', ['user-06', 'user-09', 'user-11']],
  [
    'Last active',
    'Last 5 minutes',
    [
      'user-01',
      'user-02',
      'user-03',
      'user-04',
      'user-05',
      'user-06',
      'user-07',
      'user-08',
      'user-09',
    ],
  ],
] as const)(
  '%s "%s" leaves only the matching rows',
  async (label, option, expected) => {
    renderTable();
    await screen.findByText('Page 1 of 1 · 12 matching users');
    choose(label, option);
    await waitFor(() => expect(shownUserIds()).toEqual(expected));
  },
);

it('a filter starts again at page 1', async () => {
  renderTable({ ...DEFAULT_USERS_QUERY, page: 2, pageSize: 5 });
  await screen.findByText('Page 2 of 3 · 12 matching users');

  choose('Status', 'Exceeded');

  await screen.findByText('Page 1 of 1 · 3 matching users');
  expect(shownUserIds()).toEqual(['user-06', 'user-09', 'user-11']);
});

it('the page buttons and Users per page ask for their page', async () => {
  renderTable({ ...DEFAULT_USERS_QUERY, pageSize: 5 });
  await screen.findByText('Page 1 of 3 · 12 matching users');
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Previous page' })
      .disabled,
  ).toBe(true);

  press('Next page');
  await screen.findByText('Page 2 of 3 · 12 matching users');
  expect(shownUserIds()).toEqual([
    'user-06',
    'user-07',
    'user-08',
    'user-09',
    'user-10',
  ]);

  press('Last page');
  await screen.findByText('Page 3 of 3 · 12 matching users');
  expect(shownUserIds()).toEqual(['user-11', 'user-12']);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' })
      .disabled,
  ).toBe(true);

  press('Previous page');
  await screen.findByText('Page 2 of 3 · 12 matching users');
  press('First page');
  await screen.findByText('Page 1 of 3 · 12 matching users');

  choose('Users per page', '25');
  await screen.findByText('Page 1 of 1 · 12 matching users');
  expect(shownUserIds()).toHaveLength(12);
});

it('returns to page 1 when a refresh leaves the page past the last', () => {
  const onQuery = vi.fn();
  const query = { ...DEFAULT_USERS_QUERY, page: 3, pageSize: 5 };
  render(
    <UsersTable
      rows={new Map()}
      page={pageOf([], { page: 3, pageSize: 5, total: 10 })}
      query={query}
      onQuery={onQuery}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
    />,
    { wrapper: MantineProvider },
  );

  expect(onQuery).toHaveBeenCalledExactlyOnceWith({ ...query, page: 1 });
  expect(screen.getByText('No users match the filters.')).toBeTruthy();
});

it('shows the held row of a user on the page, not the page copy', () => {
  const newer = { ...users[0], remaining: 7, version: users[0].version + 1 };
  render(
    <UsersTable
      rows={new Map([[newer.userId, newer]])}
      page={pageOf([users[0]])}
      query={DEFAULT_USERS_QUERY}
      onQuery={vi.fn()}
      snapshot={{ status: 'loaded', error: null }}
      now={now}
      onSelect={vi.fn()}
    />,
    { wrapper: MantineProvider },
  );

  expect(screen.getByText(`7 / ${newer.total}`)).toBeTruthy();
});
