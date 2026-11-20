import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Title,
} from '@mantine/core';
import type { UserRow } from '@app/contracts';
import type { Client } from '../../api/index.ts';
import type { Session } from '../../api/useSession.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { useOneAction } from './useOneAction.ts';

// The bounds the API enforces, checked here to answer without a request.
export const MAX_REQUESTS = 10_000;
const MAX_SUSPEND_MINUTES = 24 * 60;
// Wide enough for five digits, and for "Suspend minutes" on one line.
const NUMBER_FIELD_WIDTH = 130;

interface NumberAction {
  label: string;
  button: string;
  max: number;
  send: (client: Client, userId: string, value: number) => Promise<UserRow>;
}

const NUMBER_ACTIONS: NumberAction[] = [
  {
    label: 'Extra requests',
    button: 'Add extra',
    max: MAX_REQUESTS,
    send: (client, userId, amount) => client.addExtra(userId, { amount }),
  },
  {
    label: 'Set limit',
    button: 'Set limit',
    max: MAX_REQUESTS,
    send: (client, userId, limit) => client.setLimit(userId, { limit }),
  },
  {
    label: 'Suspend minutes',
    button: 'Suspend',
    max: MAX_SUSPEND_MINUTES,
    send: (client, userId, minutes) => client.suspend(userId, { minutes }),
  },
];

const PLAIN_ACTIONS: {
  button: string;
  send: (client: Client, userId: string) => Promise<UserRow>;
}[] = [
  { button: 'Reset usage', send: (client, userId) => client.reset(userId) },
  {
    button: 'Resume throttling',
    send: (client, userId) => client.unsuspend(userId),
  },
];

export function AdminForms({
  userId,
  session,
  live,
}: {
  userId: string;
  session: Session;
  live: LiveUsers;
}) {
  const { client } = session;
  const { pending, error, setError, run } = useOneAction(session, live);
  return (
    <Stack mt="md" gap="xs">
      <Title order={3}>Admin actions</Title>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      <Paper withBorder p="sm">
        <Group gap="xs" mb="sm">
          {PLAIN_ACTIONS.map(({ button, send }) => (
            <Button
              key={button}
              variant="default"
              disabled={pending}
              onClick={() => void run(() => send(client, userId))}
            >
              {button}
            </Button>
          ))}
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          {NUMBER_ACTIONS.map(({ label, button, max, send }) => (
            <NumberForm
              key={label}
              label={label}
              button={button}
              max={max}
              disabled={pending}
              onInvalid={setError}
              onSubmit={(value) => run(() => send(client, userId, value))}
            />
          ))}
        </SimpleGrid>
      </Paper>
    </Stack>
  );
}

/**
 * One whole number from 1 to `max`, starting at `initialValue` or empty;
 * the field clears once it is applied.
 */
export function NumberForm({
  label,
  button,
  max,
  initialValue,
  disabled,
  invalid = false,
  onInvalid,
  onSubmit,
}: {
  label: string;
  button: string;
  max: number;
  initialValue?: number;
  disabled: boolean;
  /** Outlines the field; the message itself is shown by the caller. */
  invalid?: boolean;
  onInvalid: (message: string) => void;
  onSubmit: (value: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState<string | number>(initialValue ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!isWholeNumberIn(value, max)) {
      onInvalid(`Enter an integer from 1 to ${max}.`);
      return;
    }
    if (await onSubmit(Number(value))) setValue('');
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Group align="end" gap="xs" wrap="nowrap">
        {/* Not clamped: a value out of range gets a message instead. */}
        <NumberInput
          label={label}
          min={1}
          max={max}
          clampBehavior="none"
          value={value}
          onChange={setValue}
          error={invalid}
          w={NUMBER_FIELD_WIDTH}
        />
        <Button type="submit" disabled={disabled}>
          {button}
        </Button>
      </Group>
    </form>
  );
}

/** Whether the field holds a whole number from 1 to `max`. */
function isWholeNumberIn(value: string | number, max: number) {
  const number = Number(value);
  return (
    value !== '' && Number.isInteger(number) && number >= 1 && number <= max
  );
}
