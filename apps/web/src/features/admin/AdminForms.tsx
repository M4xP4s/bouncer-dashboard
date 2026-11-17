import { useState, type FormEvent } from 'react';
import { Alert, Button, Group, NumberInput, Stack, Title } from '@mantine/core';
import type { UserRow } from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';

type Action = 'reset' | 'limit' | 'suspend' | 'unsuspend' | 'extra';
export function AdminForms({
  userId,
  session,
  live,
}: {
  userId: string;
  session: Session;
  live: LiveUsers;
}) {
  const [limit, setLimit] = useState<string | number>('');
  const [minutes, setMinutes] = useState<string | number>('');
  const [amount, setAmount] = useState<string | number>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function run(action: Action, value?: string | number) {
    if (pending) return;
    const number = Number(value);
    const max = action === 'suspend' ? 1440 : 10000;
    if (
      value !== undefined &&
      (value === '' || !Number.isInteger(number) || number < 1 || number > max)
    ) {
      setError(`Enter an integer from 1 to ${max}.`);
      return;
    }
    setPending(true);
    setError('');
    try {
      let row: UserRow;
      switch (action) {
        case 'reset':
          row = await session.client.reset(userId);
          break;
        case 'limit':
          row = await session.client.setLimit(userId, { limit: number });
          break;
        case 'suspend':
          row = await session.client.suspend(userId, { minutes: number });
          break;
        case 'unsuspend':
          row = await session.client.unsuspend(userId);
          break;
        case 'extra':
          row = await session.client.addExtra(userId, { amount: number });
          break;
      }
      if (session.signal.aborted) return;
      live.applyRow(row);
      if (action === 'limit') setLimit('');
      if (action === 'suspend') setMinutes('');
      if (action === 'extra') setAmount('');
    } catch (cause) {
      if (session.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Action failed.');
      live.refresh();
    } finally {
      if (!session.signal.aborted) setPending(false);
    }
  }
  const submit =
    (action: Action, value: string | number) => (event: FormEvent) => {
      event.preventDefault();
      void run(action, value);
    };
  return (
    <Stack mt="lg">
      <Title order={3}>Admin actions</Title>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      <Group>
        <Button disabled={pending} onClick={() => void run('reset')}>
          Reset usage
        </Button>
        <Button disabled={pending} onClick={() => void run('unsuspend')}>
          Resume throttling
        </Button>
      </Group>
      <form onSubmit={submit('limit', limit)}>
        <Group align="end">
          <NumberInput
            label="Set limit"
            min={1}
            max={10000}
            clampBehavior="none"
            value={limit}
            onChange={setLimit}
          />
          <Button type="submit" disabled={pending}>
            Set limit
          </Button>
        </Group>
      </form>
      <form onSubmit={submit('suspend', minutes)}>
        <Group align="end">
          <NumberInput
            label="Suspend minutes"
            min={1}
            max={1440}
            clampBehavior="none"
            value={minutes}
            onChange={setMinutes}
          />
          <Button type="submit" disabled={pending}>
            Suspend
          </Button>
        </Group>
      </form>
      <form onSubmit={submit('extra', amount)}>
        <Group align="end">
          <NumberInput
            label="Extra requests"
            min={1}
            max={10000}
            clampBehavior="none"
            value={amount}
            onChange={setAmount}
          />
          <Button type="submit" disabled={pending}>
            Add extra
          </Button>
        </Group>
      </form>
    </Stack>
  );
}
