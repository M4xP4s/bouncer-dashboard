import { useEffect, useState } from 'react';
import { BarChart } from '@mantine/charts';
import {
  Alert,
  Badge,
  Box,
  Drawer,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type {
  HistoryBucket,
  HistoryRange,
  RequestRecord,
  UserDetail,
  UserRow,
} from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import { suspensionEnd } from '../../live/rows.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { useRequest, type RequestState } from '../../lib/useRequest.ts';
import { minutesUntil, utcDateTime, utcTime } from '../../lib/time.ts';
import { AdminForms } from '../admin/AdminForms.tsx';
import { STATUS_COLOR } from '../status.ts';
import { UsageBar } from '../table/UsageBar.tsx';
import { mergeRequests } from './mergeRequests.ts';

const RANGE_OPTIONS: { label: string; value: HistoryRange }[] = [
  { label: 'Past hour', value: 'hour' },
  { label: 'Past day', value: 'day' },
];

// Each outcome in the colour of the status it leads to.
const OUTCOME_COLOR = {
  allowed: 'green',
  denied: 'red',
  bypassed: 'yellow',
} satisfies Record<RequestRecord['outcome'], string>;

const HISTORY_SERIES = [
  { name: 'allowed', color: 'blue.6', label: 'Admitted' },
  { name: 'denied', color: 'red.6', label: 'Rejected' },
];

export function UserDrawer({
  userId,
  onClose,
  session,
  live,
}: {
  userId: string | null;
  onClose: () => void;
  session: Session;
  live: LiveUsers;
}) {
  return (
    <Drawer
      opened={userId !== null}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': 'Close user details' }}
      position="right"
      size="lg"
      title={userId ?? ''}
    >
      {/* Keyed, so another user starts with empty panels and forms. */}
      {userId && (
        <DetailContent
          key={userId}
          userId={userId}
          session={session}
          live={live}
        />
      )}
    </Drawer>
  );
}

function DetailContent({
  userId,
  session,
  live,
}: {
  userId: string;
  session: Session;
  live: LiveUsers;
}) {
  const detail = useRequest(
    `detail:${userId}`,
    (signal) => session.client.detail(userId, signal),
    live.tick,
  );
  // The loaded row goes through the live ordering; the panel then shows
  // the same row as the table.
  const { applyDetailRow } = live;
  useEffect(() => {
    if (detail.data) applyDetailRow(detail.data.row);
  }, [detail.data, applyDetailRow]);

  const row = live.rows.get(userId);
  const records = mergeRequests(
    detail.data?.recentRequests ?? [],
    live.liveRecords.get(userId) ?? [],
    live.now,
  );
  return (
    <>
      {row && <UserStats row={row} now={live.now} />}
      {/* Before the history, so the controls are found without scrolling. */}
      <AdminForms userId={userId} session={session} live={live} />
      <HistorySection userId={userId} session={session} tick={live.tick} />
      <RecentRequests detail={detail} records={records} />
    </>
  );
}

function UserStats({ row, now }: { row: UserRow; now: number }) {
  const suspendedUntil = suspensionEnd(row, now);
  const values: [label: string, value: string | number][] = [
    ['Limit', row.limit],
    ['Extra', row.extra],
    ['Reset', `${utcTime(row.resetAt)} (${minutesUntil(row.resetAt, now)}m)`],
    ['Last reset', utcTime(row.lastResetAt)],
    ['Last request', row.lastRequestAt ? utcTime(row.lastRequestAt) : 'Never'],
    [
      'Suspension',
      suspendedUntil ? `Until ${utcTime(suspendedUntil)}` : 'Not suspended',
    ],
  ];
  return (
    <Stack component="section" aria-label="User stats" gap="xs">
      <Group gap="sm" wrap="nowrap">
        <Badge color={STATUS_COLOR[row.status]}>{row.status}</Badge>
        <div style={{ flex: 1 }}>
          <UsageBar used={row.used} total={row.total} status={row.status} />
        </div>
      </Group>
      <Text>{`${row.used} used of ${row.total} · ${row.remaining} remaining`}</Text>
      <SimpleGrid component="dl" cols={3} spacing="xs" m={0}>
        {values.map(([label, value]) => (
          <LabelledValue key={label} label={label} value={value} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function LabelledValue({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <Box
      bg="gray.0"
      p="xs"
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
    >
      <Text component="dt" size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text component="dd" fw={600} m={0}>
        {value}
      </Text>
    </Box>
  );
}

const total = (buckets: HistoryBucket[], field: 'allowed' | 'denied') =>
  buckets.reduce((sum, bucket) => sum + bucket[field], 0);

function HistorySection({
  userId,
  session,
  tick,
}: {
  userId: string;
  session: Session;
  tick: number;
}) {
  const [range, setRange] = useState<HistoryRange>('hour');
  const history = useRequest(
    `history:${userId}:${range}`,
    (signal) => session.client.history(userId, range, signal),
    tick,
  );
  return (
    <section aria-label="History">
      <Group gap="sm" mt="lg" mb="xs">
        <Title order={3}>History</Title>
        <SegmentedControl
          aria-label="History range"
          size="xs"
          value={range}
          onChange={setRange}
          data={RANGE_OPTIONS}
        />
      </Group>
      {history.loading && !history.data && <Text>Loading history…</Text>}
      {history.error && (
        <Alert color="red">
          Could not load history: {history.error.message}
        </Alert>
      )}
      {history.data && <HistoryChart buckets={history.data} />}
    </section>
  );
}

function HistoryChart({ buckets }: { buckets: HistoryBucket[] }) {
  const bars = buckets.map((bucket) => ({
    ...bucket,
    label: utcTime(bucket.start),
  }));
  return (
    <>
      <Text>
        Admitted: {total(buckets, 'allowed')}; rejected:{' '}
        {total(buckets, 'denied')}
      </Text>
      <BarChart
        h={220}
        data={bars}
        dataKey="label"
        type="stacked"
        series={HISTORY_SERIES}
      />
    </>
  );
}

function RecentRequests({
  detail,
  records,
}: {
  detail: RequestState<UserDetail>;
  records: RequestRecord[];
}) {
  const none = records.length === 0 && detail.data !== undefined;
  return (
    <section aria-label="Recent requests">
      <Title order={3} mt="lg">
        Recent requests
      </Title>
      <Text size="sm">Last 100 requests from the past 24 hours (UTC)</Text>
      {detail.loading && !detail.data && <Text>Loading recent requests…</Text>}
      {detail.error && (
        <Alert color="red">
          Could not load recent requests: {detail.error.message}
        </Alert>
      )}
      {none && <Text>No recent requests.</Text>}
      {records.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time (UTC)</Table.Th>
              <Table.Th>Outcome</Table.Th>
              <Table.Th>Remaining</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {records.map((record) => (
              <Table.Tr key={record.id}>
                <Table.Td>{utcDateTime(record.at)}</Table.Td>
                <Table.Td>
                  <Badge color={OUTCOME_COLOR[record.outcome]}>
                    {record.outcome}
                  </Badge>
                </Table.Td>
                <Table.Td>{record.remaining}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </section>
  );
}
