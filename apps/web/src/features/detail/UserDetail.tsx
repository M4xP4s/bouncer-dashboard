import { useEffect, useState } from 'react';
import { BarChart } from '@mantine/charts';
import {
  Alert,
  Drawer,
  SegmentedControl,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { HistoryRange } from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { useRequest } from '../../lib/useRequest.ts';
import { utcTime } from '../../lib/time.ts';
import { mergeRequests } from './mergeRequests.ts';

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
  const [range, setRange] = useState<HistoryRange>('hour');
  const detail = useRequest(
    `detail:${userId}`,
    (signal) => session.client.detail(userId, signal),
    live.tick,
  );
  const history = useRequest(
    `history:${userId}:${range}`,
    (signal) => session.client.history(userId, range, signal),
    live.tick,
  );
  const applyRow = live.applyRow;
  useEffect(() => {
    if (detail.data) applyRow(detail.data.row);
  }, [detail.data, applyRow]);
  const row = live.rows.get(userId);
  const records = mergeRequests(
    detail.data?.recentRequests ?? [],
    live.liveRecords.get(userId) ?? [],
    live.now,
  );
  const allowed =
    history.data?.reduce((sum, item) => sum + item.allowed, 0) ?? 0;
  const denied = history.data?.reduce((sum, item) => sum + item.denied, 0) ?? 0;
  return (
    <>
      {row && (
        <section aria-label="User stats">
          <Title order={3}>{row.status}</Title>
          <Text>
            Used {row.used}; limit {row.limit}; extra {row.extra}; total{' '}
            {row.total}; remaining {row.remaining}
          </Text>
          <Text>
            Reset {utcTime(row.resetAt)}; last reset {utcTime(row.lastResetAt)}
          </Text>
          <Text>
            Last request:{' '}
            {row.lastRequestAt ? utcTime(row.lastRequestAt) : 'Never'}
          </Text>
          <Text>
            Suspension:{' '}
            {row.suspendedUntil && Date.parse(row.suspendedUntil) > live.now
              ? `until ${utcTime(row.suspendedUntil)}`
              : 'Not suspended'}
          </Text>
        </section>
      )}
      <section aria-label="History">
        <Title order={3} mt="lg">
          History
        </Title>
        <SegmentedControl
          aria-label="History range"
          value={range}
          onChange={(value) => setRange(value as HistoryRange)}
          data={[
            { label: 'Past hour', value: 'hour' },
            { label: 'Past day', value: 'day' },
          ]}
        />
        {history.loading && !history.data && <Text>Loading history…</Text>}
        {history.error && (
          <Alert color="red">
            Could not load history: {history.error.message}
          </Alert>
        )}
        {history.data && (
          <>
            <Text>
              Admitted: {allowed}; rejected: {denied}
            </Text>
            <BarChart
              h={220}
              data={history.data.map((bucket) => ({
                ...bucket,
                label: utcTime(bucket.start),
              }))}
              dataKey="label"
              type="stacked"
              series={[
                { name: 'allowed', color: 'blue.6', label: 'Admitted' },
                { name: 'denied', color: 'red.6', label: 'Rejected' },
              ]}
            />
          </>
        )}
      </section>
      <section aria-label="Recent requests">
        <Title order={3} mt="lg">
          Recent requests
        </Title>
        <Text size="sm">Last 100 requests from the past 24 hours (UTC)</Text>
        {detail.loading && !detail.data && (
          <Text>Loading recent requests…</Text>
        )}
        {detail.error && (
          <Alert color="red">
            Could not load recent requests: {detail.error.message}
          </Alert>
        )}
        {records.length === 0 && detail.data && (
          <Text>No recent requests.</Text>
        )}
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
                  <Table.Td>
                    {record.at.replace('T', ' ').replace('Z', ' UTC')}
                  </Table.Td>
                  <Table.Td>{record.outcome}</Table.Td>
                  <Table.Td>{record.remaining}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </section>
    </>
  );
}
