// What the admin controls send: the API answers a non-numeric body with 400.
// The input-validation cases are in `features/dashboard.test.tsx`.
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { UserRow } from '@app/contracts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { users } from '../../fixtures/index.ts';
import { deferred, mockClient } from '../../lib/test-helpers.ts';
import { AdminForms } from './AdminForms.tsx';

function renderForms() {
  const client = mockClient();
  const session = {
    token: 'token',
    signal: new AbortController().signal,
    client,
    onRefused: vi.fn(),
  };
  const live: LiveUsers = {
    rows: new Map(),
    page: null,
    liveRecords: new Map(),
    connection: 'live',
    lastUpdateAt: null,
    snapshot: { status: 'loaded', error: null },
    now: 0,
    tick: 0,
    applyRow: vi.fn(),
    applyDetailRow: vi.fn(),
    keep: vi.fn(),
    refresh: vi.fn(),
  };
  render(<AdminForms userId="user-01" session={session} live={live} />, {
    wrapper: MantineProvider,
  });
  return { client, live };
}

it.each([
  ['Suspend minutes', 'Suspend', 'suspend', '30', { minutes: 30 }],
  ['Extra requests', 'Add extra', 'addExtra', '25', { amount: 25 }],
] as const)(
  '%s sends a numeric body through %s',
  async (label, button, method, typed, body) => {
    const { client, live } = renderForms();
    client[method].mockResolvedValue(users[0]);
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: typed },
    });
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() =>
      expect(client[method]).toHaveBeenCalledWith('user-01', body),
    );
    await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(users[0]));
  },
);

it('Resume throttling ends the suspension and shows the returned row', async () => {
  const { client, live } = renderForms();
  client.unsuspend.mockResolvedValue(users[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Resume throttling' }));
  await waitFor(() => expect(client.unsuspend).toHaveBeenCalledWith('user-01'));
  await waitFor(() => expect(live.applyRow).toHaveBeenCalledWith(users[0]));
});

it('runs one action at a time', async () => {
  const { client } = renderForms();
  const reset = deferred<UserRow>();
  client.reset.mockReturnValue(reset.promise);
  const button = (name: string) =>
    screen.getByRole<HTMLButtonElement>('button', { name });

  fireEvent.click(button('Reset usage'));

  expect(button('Resume throttling').disabled).toBe(true);
  expect(button('Set limit').disabled).toBe(true);
  fireEvent.click(button('Resume throttling'));
  expect(client.unsuspend).not.toHaveBeenCalled();

  reset.resolve(users[0]);
  await waitFor(() => expect(button('Resume throttling').disabled).toBe(false));
});
