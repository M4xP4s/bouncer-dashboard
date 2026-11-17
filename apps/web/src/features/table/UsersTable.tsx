import {
  Alert,
  Badge,
  Button,
  Group,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect } from 'react';
import type { Status, UserRow, UsersPage, UsersQuery } from '@app/contracts';
import {
  FIRST_PAGE,
  SEARCH_MAX_LENGTH,
  lastPage,
} from '../../api/usersQuery.ts';
import { pageRows, suspensionEnd, type Rows } from '../../live/rows.ts';
import type { SnapshotState } from '../../live/useLiveUsers.ts';
import { minutesUntil, utcTime } from '../../lib/time.ts';

const STATUS_COLOR = {
  OK: 'green',
  Warning: 'yellow',
  Exceeded: 'red',
} satisfies Record<Status, string>;

interface Option<T extends string> {
  value: T;
  label: string;
}

const STATUS_OPTIONS: Option<UsersQuery['status']>[] = [
  { value: 'any', label: 'Any' },
  { value: 'OK', label: 'OK' },
  { value: 'Warning', label: 'Warning' },
  { value: 'Exceeded', label: 'Exceeded' },
];

const ACTIVE_OPTIONS: Option<UsersQuery['active']>[] = [
  { value: 'any', label: 'Any time' },
  { value: '5m', label: 'Last 5 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
];

const PAGE_SIZE_OPTIONS = ['25', '50', '100'];

/** The typed value of the option a Select reports as a plain string. */
const chosen = <T extends string>(
  options: Option<T>[],
  value: string | null,
): T => (options.find((option) => option.value === value) ?? options[0]).value;

export function UsersTable({
  rows,
  page,
  query,
  onQuery,
  snapshot,
  now,
  onSelect,
}: {
  rows: Rows;
  page: UsersPage | null;
  query: UsersQuery;
  onQuery: (query: UsersQuery) => void;
  snapshot: SnapshotState;
  now: number;
  onSelect: (id: string) => void;
}) {
  const shown = pageRows(page, rows);
  const noMatch = snapshot.status === 'loaded' && shown.length === 0;

  // Users can leave a filtered list between two reads, so the page asked
  // for can end up past the last.
  useEffect(() => {
    if (page && page.page > lastPage(page)) {
      onQuery({ ...query, page: FIRST_PAGE });
    }
  }, [page, query, onQuery]);

  return (
    <>
      <UserFilters query={query} onQuery={onQuery} />
      <PageControls query={query} page={page} onQuery={onQuery} />
      {snapshot.status === 'pending' && <Text>Loading users…</Text>}
      {snapshot.status === 'error' && (
        <Alert color="red">
          Could not load users: {snapshot.error.message}
        </Alert>
      )}
      {noMatch && <Text>No users match the filters.</Text>}
      {shown.length > 0 && (
        <UserRowsTable rows={shown} now={now} onSelect={onSelect} />
      )}
    </>
  );
}

function UserFilters({
  query,
  onQuery,
}: {
  query: UsersQuery;
  onQuery: (query: UsersQuery) => void;
}) {
  const firstPageWith = (change: Partial<UsersQuery>) =>
    onQuery({ ...query, ...change, page: FIRST_PAGE });
  return (
    <Group mb="md" align="end">
      <TextInput
        label="Search user ID"
        value={query.search}
        maxLength={SEARCH_MAX_LENGTH}
        onChange={(event) =>
          firstPageWith({ search: event.currentTarget.value })
        }
      />
      <Select
        label="Status"
        value={query.status}
        onChange={(value) =>
          firstPageWith({ status: chosen(STATUS_OPTIONS, value) })
        }
        data={STATUS_OPTIONS}
        allowDeselect={false}
      />
      <Select
        label="Last active"
        value={query.active}
        onChange={(value) =>
          firstPageWith({ active: chosen(ACTIVE_OPTIONS, value) })
        }
        data={ACTIVE_OPTIONS}
        allowDeselect={false}
      />
      <Select
        label="Users per page"
        value={String(query.pageSize)}
        onChange={(value) => firstPageWith({ pageSize: Number(value) })}
        data={PAGE_SIZE_OPTIONS}
        allowDeselect={false}
      />
    </Group>
  );
}

const pageSummary = (page: UsersPage) =>
  `Page ${page.page} of ${lastPage(page)} · ${page.total} matching users`;

function PageControls({
  query,
  page,
  onQuery,
}: {
  query: UsersQuery;
  page: UsersPage | null;
  onQuery: (query: UsersQuery) => void;
}) {
  // Until the page answers, its last page is unknown: only going back works.
  const last = page ? lastPage(page) : query.page;
  const onFirst = query.page === FIRST_PAGE;
  const onLast = query.page >= last;
  const goTo = (pageNumber: number) => onQuery({ ...query, page: pageNumber });
  return (
    <Group mb="md">
      <Button
        variant="default"
        disabled={onFirst}
        onClick={() => goTo(FIRST_PAGE)}
      >
        First page
      </Button>
      <Button
        variant="default"
        disabled={onFirst}
        onClick={() => goTo(query.page - 1)}
      >
        Previous page
      </Button>
      <Button
        variant="default"
        disabled={onLast}
        onClick={() => goTo(query.page + 1)}
      >
        Next page
      </Button>
      <Button variant="default" disabled={onLast} onClick={() => goTo(last)}>
        Last page
      </Button>
      {page && (
        <>
          <Text>{pageSummary(page)}</Text>
          <Text size="xs">Updated {utcTime(page.completedAt)}</Text>
        </>
      )}
    </Group>
  );
}

function UserRowsTable({
  rows,
  now,
  onSelect,
}: {
  rows: UserRow[];
  now: number;
  onSelect: (id: string) => void;
}) {
  return (
    <Table.ScrollContainer minWidth={640} type="native">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>User ID</Table.Th>
            <Table.Th>Remaining / Total</Table.Th>
            <Table.Th>Reset Time</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Last Request</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <UserTableRow
              key={row.userId}
              row={row}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function UserTableRow({
  row,
  now,
  onSelect,
}: {
  row: UserRow;
  now: number;
  onSelect: (id: string) => void;
}) {
  const suspendedUntil = suspensionEnd(row, now);
  return (
    <Table.Tr>
      <Table.Td>
        {/* A button, so the keyboard can open the details too. */}
        <Button variant="subtle" px={0} onClick={() => onSelect(row.userId)}>
          {row.userId}
        </Button>
      </Table.Td>
      <Table.Td>
        {row.remaining} / {row.total}
      </Table.Td>
      <Table.Td>
        {utcTime(row.resetAt)} ({minutesUntil(row.resetAt, now)}m)
      </Table.Td>
      <Table.Td>
        <Badge color={STATUS_COLOR[row.status]}>{row.status}</Badge>
        {suspendedUntil && (
          <Text size="xs">
            Throttling suspended until {utcTime(suspendedUntil)}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {row.lastRequestAt ? utcTime(row.lastRequestAt) : 'Never'}
      </Table.Td>
    </Table.Tr>
  );
}
