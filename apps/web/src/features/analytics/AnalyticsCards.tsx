import { Alert, Card, SimpleGrid, Text, Title } from '@mantine/core';
import type { Analytics } from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import { useRequest } from '../../lib/useRequest.ts';

export function AnalyticsCards({
  session,
  tick,
}: {
  session: Session;
  tick: number;
}) {
  const { data, error, loading } = useRequest(
    'analytics',
    (signal) => session.client.analytics(signal),
    tick,
  );
  return (
    <section aria-label="Analytics">
      {loading && !data && <Text>Loading analytics…</Text>}
      {error && (
        <Alert color="red">Could not load analytics: {error.message}</Alert>
      )}
      {data && <AnalyticsGrid analytics={data} />}
    </section>
  );
}

function AnalyticsGrid({ analytics }: { analytics: Analytics }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mb="lg">
      <Card withBorder>
        <Title order={3}>Total users</Title>
        <Text>{analytics.totalUsers}</Text>
        <Text size="xs">All seeded users</Text>
      </Card>
      <Card withBorder>
        <Title order={3}>Near limit</Title>
        <Text>{analytics.nearLimitPercent}%</Text>
        <Text size="xs">
          Of users active this hour, the share at 90% or more of their limit,
          including exceeded users
        </Text>
      </Card>
      <Card withBorder>
        <Title order={3}>429 today</Title>
        <Text>{analytics.denied429Today}</Text>
        <Text size="xs">429 responses today (UTC), {analytics.day}</Text>
      </Card>
      <Card withBorder>
        <Title order={3}>Top users</Title>
        <Text size="xs">By requests this hour</Text>
        {analytics.topUsers.map((user) => (
          <Text key={user.userId}>
            {user.userId}: {user.used} / {user.total}
          </Text>
        ))}
      </Card>
    </SimpleGrid>
  );
}
