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
import { type Connection, useLiveUsers } from './live/useLiveUsers.ts';
import { utcTime } from './lib/time.ts';
import { useSession, type Session } from './api/useSession.ts';

// Kept for the browser session only: closing the tab forgets it.
const TOKEN_KEY = 'adminToken';

// A browser that blocks site data throws on every storage call. The token
// is then kept in memory only and is asked for again after a reload.
function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing to do: see above.
  }
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
  // Stable, because the socket's effect depends on it.
  const refuse = useCallback(() => {
    storeToken(null);
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

/** Announce connection changes; the frequently changing timestamp stays outside the live region. */
function connectionText(connection: Connection) {
  if (connection === 'connecting') return 'Connecting…';
  if (connection === 'disconnected') return 'Disconnected, reconnecting…';
  return 'Live';
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
  const live = useLiveUsers(session, (event) =>
    notifications.show({
      title: `Limit exceeded: ${event.row.userId}`,
      message: `Retry at ${utcTime(event.retryAt)}`,
      color: 'red',
      autoClose: 5000,
    }),
  );
  const { connection, lastUpdateAt } = live;
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={1}>Rate limits</Title>
        <Group gap="xs">
          <Text role="status" c={connection === 'live' ? 'green' : 'orange'}>
            {connectionText(connection)}
          </Text>
          <Text>
            {lastUpdateAt
              ? `Last update ${utcTime(lastUpdateAt)}`
              : 'No update yet'}
          </Text>
        </Group>
      </Group>
    </>
  );
}
