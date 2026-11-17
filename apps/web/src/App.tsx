import { type FormEvent, useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Container,
  Group,
  PasswordInput,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { RateLimitExceededEvent } from '@app/contracts';
import { type Connection, useLiveUsers } from './live/useLiveUsers.ts';
import { SECOND_MS, utcTime } from './lib/time.ts';
import { useSession, type Session } from './api/useSession.ts';

// In sessionStorage: closing the tab forgets the token.
const TOKEN_KEY = 'adminToken';
const ALERT_VISIBLE_MS = 5 * SECOND_MS;

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  disconnected: 'Disconnected, reconnecting…',
};

// A browser that blocks site data throws on every storage call. The token
// then lives in memory only and is asked for again after a reload.
function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Blocked storage: see storedToken.
  }
}

function forgetToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Blocked storage: see storedToken.
  }
}

function showLimitAlert(event: RateLimitExceededEvent): void {
  notifications.show({
    title: `Limit exceeded: ${event.row.userId}`,
    message: `Retry at ${utcTime(event.retryAt)}`,
    color: 'red',
    autoClose: ALERT_VISIBLE_MS,
  });
}

/** Token gate and layout. The rows live in `useLiveUsers`. */
export default function App() {
  const [token, setToken] = useState(storedToken);
  const [refused, setRefused] = useState(false);

  const open = (entered: string) => {
    storeToken(entered);
    setRefused(false);
    setToken(entered);
  };
  // Stable, because the session's effect depends on it.
  const refuse = useCallback(() => {
    forgetToken();
    setRefused(true);
    setToken('');
  }, []);

  return (
    <Container size="xl" py="xl">
      {token ? (
        <Dashboard key={token} token={token} onRefused={refuse} />
      ) : (
        <TokenForm refused={refused} onSubmit={open} />
      )}
    </Container>
  );
}

function TokenForm({
  refused,
  onSubmit,
}: {
  refused: boolean;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value) onSubmit(value);
  };
  return (
    <form onSubmit={submit}>
      <Title order={1} mb="md">
        Rate limits
      </Title>
      {refused && (
        <Alert color="red" mb="md">
          The admin token was not accepted.
        </Alert>
      )}
      <PasswordInput
        label="Admin token"
        description="Demo authentication: one shared token from the server's configuration."
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        mb="md"
      />
      <Button type="submit">Open dashboard</Button>
    </form>
  );
}

function Dashboard({
  token,
  onRefused,
}: {
  token: string;
  onRefused: () => void;
}) {
  const session = useSession(token, onRefused);
  if (!session) return <Text>Opening dashboard…</Text>;
  return <DashboardContent session={session} />;
}

function DashboardContent({ session }: { session: Session }) {
  const live = useLiveUsers(session, showLimitAlert);
  return (
    <Group justify="space-between" mb="md">
      <Title order={1}>Rate limits</Title>
      <ConnectionStatus
        connection={live.connection}
        lastUpdateAt={live.lastUpdateAt}
      />
    </Group>
  );
}

function ConnectionStatus({
  connection,
  lastUpdateAt,
}: {
  connection: Connection;
  lastUpdateAt: string | null;
}) {
  const lastUpdate = lastUpdateAt
    ? `Last update ${utcTime(lastUpdateAt)}`
    : 'No update yet';
  // Only the connection is a live region: the time changes too often to
  // be announced.
  return (
    <Group gap="xs">
      <Text role="status" c={connection === 'live' ? 'green' : 'orange'}>
        {CONNECTION_TEXT[connection]}
      </Text>
      <Text>{lastUpdate}</Text>
    </Group>
  );
}
