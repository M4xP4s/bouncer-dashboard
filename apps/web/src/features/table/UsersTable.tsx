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
import { useState } from 'react';
import type { Status, UserRow } from '@app/contracts';
import { STATUSES } from '../../api/validation.ts';
import { suspensionEnd, type Rows } from '../../live/rows.ts';
import type { SnapshotState } from '../../live/useLiveUsers.ts';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  minutesUntil,
  utcTime,
} from '../../lib/time.ts';
import { ANY, filterUsers } from './filterUsers.ts';

const STATUS_COLOR = {
  OK: 'green',
  Warning: 'yellow',
  Exceeded: 'red',
} satisfies Record<Status, string>;

const STATUS_OPTIONS = [{ value: ANY, label: 'Any' }, ...STATUSES];

// A Select holds strings, so each period is its length in milliseconds.
const ACTIVE_OPTIONS = [
  { value: ANY, label: 'Any time' },
  { value: String(5 * MINUTE_MS), label: 'Last 5 minutes' },
  { value: String(HOUR_MS), label: 'Last hour' },
  { value: String(DAY_MS), label: 'Last 24 hours' },
];

interface Filters {
  search: string;
  status: string;
  activePeriodMs: string;
}

const NO_FILTERS: Filters = { search: '', status: ANY, activePeriodMs: ANY };

export function UsersTable({
  rows,
  snapshot,
  now,
  onSelect,
}: {
  rows: Rows;
  snapshot: SnapshotState;
  now: number;
  onSelect: (id: string) => void;
}) {
  const [filters, setFilters] = useState(NO_FILTERS);
  const { search, status, activePeriodMs } = filters;
  const users = [...rows.values()];
  const filtered = filterUsers(users, search, status, activePeriodMs, now);
  const noMatch = snapshot.status === 'loaded' && filtered.length === 0;
  return (
    <>
      <UserFilters filters={filters} onChange={setFilters} />
      {snapshot.status === 'pending' && <Text>Loading users…</Text>}
      {snapshot.status === 'error' && (
        <Alert color="red">
          Could not load users: {snapshot.error?.message}
        </Alert>
      )}
      {noMatch && <Text>No users match the filters.</Text>}
      {filtered.length > 0 && (
        <UserRowsTable rows={filtered} now={now} onSelect={onSelect} />
      )}
    </>
  );
}

function UserFilters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  return (
    <Group mb="md" align="end">
      <TextInput
        label="Search user ID"
        value={filters.search}
        onChange={(event) =>
          onChange({ ...filters, search: event.currentTarget.value })
        }
      />
      <Select
        label="Status"
        value={filters.status}
        onChange={(value) => onChange({ ...filters, status: value ?? ANY })}
        data={STATUS_OPTIONS}
        allowDeselect={false}
      />
      <Select
        label="Last active"
        value={filters.activePeriodMs}
        onChange={(value) =>
          onChange({ ...filters, activePeriodMs: value ?? ANY })
        }
        data={ACTIVE_OPTIONS}
        allowDeselect={false}
      />
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
