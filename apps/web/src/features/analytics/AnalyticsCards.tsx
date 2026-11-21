import type { ReactNode } from 'react';
import { Alert, Box, Card, SimpleGrid, Text } from '@mantine/core';
import type { Analytics } from '@app/contracts';
import { utcTime } from '../../lib/time.ts';
import type { RequestState } from '../../lib/useRequest.ts';
import { UsageBar } from '../table/UsageBar.tsx';

// Large enough to be read first, small enough for four cards in a row.
const VALUE_SIZE = '1.75rem';
const VALUE_LINE_HEIGHT = 1.2;
const TOP_USER_BAR_WIDTH = 120;
// IDs run to 64 characters and may differ only at the end, so the ID takes the
// free width and wraps anywhere instead of being cut. The columns are shared by
// every line, so the bars start together whatever the counts' widths.
const TOP_USERS_STYLE = {
  display: 'grid',
  gridTemplateColumns: `minmax(0, 1fr) ${TOP_USER_BAR_WIDTH}px auto`,
  columnGap: 'var(--mantine-spacing-xs)',
  listStyle: 'none',
} as const;
const TOP_USER_LINE_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'subgrid',
  gridColumn: '1 / -1',
  alignItems: 'center',
} as const;
const TOP_USER_ID_STYLE = { overflowWrap: 'anywhere' } as const;

/** The four cards, from the dashboard's one analytics read. */
export function AnalyticsCards({
  analytics,
}: {
  analytics: RequestState<Analytics>;
}) {
  const { data, error, loading } = analytics;
  return (
    <section aria-label="Analytics">
      {loading && !data && <Text>Loading analytics…</Text>}
      {error && (
        <Alert color="red" mb="sm">
          Could not load analytics: {error.message}
        </Alert>
      )}
      {data && (
        <Text size="xs" c="dimmed" ta="right" mb="xs">
          Updated {utcTime(data.completedAt)}
        </Text>
      )}
      {data && <AnalyticsGrid analytics={data} />}
    </section>
  );
}

function AnalyticsCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Card withBorder padding="sm">
      <Text component="h2" size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      {children}
    </Card>
  );
}

const CardValue = ({ children }: { children: ReactNode }) => (
  <Text fz={VALUE_SIZE} fw={700} lh={VALUE_LINE_HEIGHT}>
    {children}
  </Text>
);

function AnalyticsGrid({ analytics }: { analytics: Analytics }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm" mb="md">
      <AnalyticsCard label="Total users">
        <CardValue>{analytics.totalUsers}</CardValue>
        <Text size="xs">All registered users</Text>
      </AnalyticsCard>
      <AnalyticsCard label="Near limit">
        <CardValue>{analytics.nearLimitPercent}%</CardValue>
        <Text size="xs">
          Of users active this hour, the share at 90% or more of their limit,
          including exceeded users
        </Text>
      </AnalyticsCard>
      <AnalyticsCard label="429 today">
        <CardValue>{analytics.denied429Today}</CardValue>
        <Text size="xs">429 responses today (UTC), {analytics.day}</Text>
      </AnalyticsCard>
      <AnalyticsCard label="Top users">
        <Text size="xs">By requests this hour</Text>
        <TopUsers users={analytics.topUsers} />
      </AnalyticsCard>
    </SimpleGrid>
  );
}

function TopUsers({ users }: { users: Analytics['topUsers'] }) {
  return (
    <Box component="ul" p={0} m={0} mt="xs" style={TOP_USERS_STYLE}>
      {users.map((user) => (
        <li key={user.userId} style={TOP_USER_LINE_STYLE}>
          <Text size="sm" fw={600} style={TOP_USER_ID_STYLE}>
            {user.userId}
          </Text>
          <UsageBar used={user.used} total={user.total} />
          <Text size="sm">
            {user.used} / {user.total}
          </Text>
        </li>
      ))}
    </Box>
  );
}
