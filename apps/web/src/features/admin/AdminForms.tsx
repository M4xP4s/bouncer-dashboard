import { useState, type FormEvent } from 'react';
import { Alert, Button, Group, NumberInput, Stack, Title } from '@mantine/core';
import type { UserRow } from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { toError } from '../../lib/async.ts';

// The bounds the API enforces, checked here to answer without a request.
const MAX_REQUESTS = 10_000;
const MAX_SUSPEND_MINUTES = 24 * 60;

export function AdminForms({
  userId,
  session,
  live,
}: {
  userId: string;
  session: Session;
  live: LiveUsers;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { client, signal } = session;

  /** Resolves true when the server applied the action. */
  async function run(send: () => Promise<UserRow>): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError('');
    try {
      const row = await send();
      if (signal.aborted) return false;
      live.applyRow(row);
      return true;
    } catch (thrown) {
      if (signal.aborted) return false;
      setError(toError(thrown, 'Action failed.').message);
      // The action may have been applied before it failed.
      live.refresh();
      return false;
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }

  return (
    <Stack mt="lg">
      <Title order={3}>Admin actions</Title>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      <Group>
        <Button
          disabled={pending}
          onClick={() => void run(() => client.reset(userId))}
        >
          Reset usage
        </Button>
        <Button
          disabled={pending}
          onClick={() => void run(() => client.unsuspend(userId))}
        >
          Resume throttling
        </Button>
      </Group>
      <NumberForm
        label="Set limit"
        button="Set limit"
        max={MAX_REQUESTS}
        disabled={pending}
        onInvalid={setError}
        onSubmit={(limit) => run(() => client.setLimit(userId, { limit }))}
      />
      <NumberForm
        label="Suspend minutes"
        button="Suspend"
        max={MAX_SUSPEND_MINUTES}
        disabled={pending}
        onInvalid={setError}
        onSubmit={(minutes) => run(() => client.suspend(userId, { minutes }))}
      />
      <NumberForm
        label="Extra requests"
        button="Add extra"
        max={MAX_REQUESTS}
        disabled={pending}
        onInvalid={setError}
        onSubmit={(amount) => run(() => client.addExtra(userId, { amount }))}
      />
    </Stack>
  );
}

/** One whole number from 1 to `max`; the field clears once it is applied. */
function NumberForm({
  label,
  button,
  max,
  disabled,
  onInvalid,
  onSubmit,
}: {
  label: string;
  button: string;
  max: number;
  disabled: boolean;
  onInvalid: (message: string) => void;
  onSubmit: (value: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState<string | number>('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const number = Number(value);
    const valid =
      value !== '' && Number.isInteger(number) && number >= 1 && number <= max;
    if (!valid) {
      onInvalid(`Enter an integer from 1 to ${max}.`);
      return;
    }
    if (await onSubmit(number)) setValue('');
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Group align="end">
        {/* Not clamped: a value out of range gets a message instead. */}
        <NumberInput
          label={label}
          min={1}
          max={max}
          clampBehavior="none"
          value={value}
          onChange={setValue}
        />
        <Button type="submit" disabled={disabled}>
          {button}
        </Button>
      </Group>
    </form>
  );
}
