import { Alert, Card, SimpleGrid, Text, Title } from '@mantine/core';
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
      {data && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mb="lg">
          <Card withBorder>
            <Title order={3}>Total users</Title>
            <Text>{data.totalUsers}</Text>
            <Text size="xs">All seeded users</Text>
          </Card>
          <Card withBorder>
            <Title order={3}>Near limit</Title>
            <Text>{data.nearLimitPercent}%</Text>
            <Text size="xs">
              Of users active this hour, the share at 90% or more of their
              limit, including exceeded users
            </Text>
          </Card>
          <Card withBorder>
            <Title order={3}>429 today</Title>
            <Text>{data.denied429Today}</Text>
            <Text size="xs">429 responses today (UTC), {data.day}</Text>
          </Card>
          <Card withBorder>
            <Title order={3}>Top users</Title>
            <Text size="xs">By requests this hour</Text>
            {data.topUsers.map((user) => (
              <Text key={user.userId}>
                {user.userId}: {user.used} / {user.total}
              </Text>
            ))}
          </Card>
        </SimpleGrid>
      )}
    </section>
  );
}
