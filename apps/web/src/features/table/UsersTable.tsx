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
import type { Status } from '@app/contracts';
import type { Rows } from '../../live/rows.ts';
import type { SnapshotState } from '../../live/useLiveUsers.ts';
import { utcTime } from '../../lib/time.ts';
import { filterUsers } from './filterUsers.ts';

const STATUS_COLOR = {
  OK: 'green',
  Warning: 'yellow',
  Exceeded: 'red',
} satisfies Record<Status, string>;

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
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('any');
  const [active, setActive] = useState('any');
  const filtered = filterUsers([...rows.values()], search, status, active, now);
  return (
    <>
      <Group mb="md" align="end">
        <TextInput
          label="Search user ID"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <Select
          label="Status"
          value={status}
          onChange={(value) => setStatus(value ?? 'any')}
          data={[{ value: 'any', label: 'Any' }, 'OK', 'Warning', 'Exceeded']}
          allowDeselect={false}
        />
        <Select
          label="Last active"
          value={active}
          onChange={(value) => setActive(value ?? 'any')}
          data={[
            { value: 'any', label: 'Any time' },
            { value: '300000', label: 'Last 5 minutes' },
            { value: '3600000', label: 'Last hour' },
            { value: '86400000', label: 'Last 24 hours' },
          ]}
          allowDeselect={false}
        />
      </Group>
      {snapshot.status === 'pending' && <Text>Loading users…</Text>}
      {snapshot.status === 'error' && (
        <Alert color="red">
          Could not load users: {snapshot.error?.message}
        </Alert>
      )}
      {snapshot.status === 'loaded' && filtered.length === 0 && (
        <Text>No users match the filters.</Text>
      )}
      {filtered.length > 0 && (
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
              {filtered.map((row) => (
                <Table.Tr key={row.userId}>
                  <Table.Td>
                    <Button
                      variant="subtle"
                      px={0}
                      onClick={() => onSelect(row.userId)}
                    >
                      {row.userId}
                    </Button>
                  </Table.Td>
                  <Table.Td>
                    {row.remaining} / {row.total}
                  </Table.Td>
                  <Table.Td>
                    {utcTime(row.resetAt)} (
                    {Math.max(
                      0,
                      Math.ceil((Date.parse(row.resetAt) - now) / 60000),
                    )}
                    m)
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[row.status]}>{row.status}</Badge>
                    {row.suspendedUntil &&
                      Date.parse(row.suspendedUntil) > now && (
                        <Text size="xs">
                          Throttling suspended until{' '}
                          {utcTime(row.suspendedUntil)}
                        </Text>
                      )}
                  </Table.Td>
                  <Table.Td>
                    {row.lastRequestAt ? utcTime(row.lastRequestAt) : 'Never'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </>
  );
}
