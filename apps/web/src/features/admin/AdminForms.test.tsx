// Guards what the admin controls send to the API: Suspend and Add extra must
// post a numeric `minutes` / `amount` (the API rejects any other body with
// 400), and Resume throttling must call the unsuspend endpoint and show the
// returned row. The input-validation cases live in `features/dashboard.test.tsx`.
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { users } from '../../fixtures/index.ts';
import { mockClient } from '../../lib/test-helpers.ts';
import { AdminForms } from './AdminForms.tsx';

function renderForms() {
  const client = mockClient();
  const session = {
    token: 'token',
    signal: new AbortController().signal,
    client,
    onRefused: vi.fn(),
  };
  const live = { applyRow: vi.fn(), refresh: vi.fn() } as unknown as LiveUsers;
  render(
    <MantineProvider>
      <AdminForms userId="user-01" session={session} live={live} />
    </MantineProvider>,
  );
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
