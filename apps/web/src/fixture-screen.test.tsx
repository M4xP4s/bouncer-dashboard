import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.tsx';

const calls = vi.hoisted(() => ({
  users: vi.fn(),
  detail: vi.fn(),
  history: vi.fn(),
  analytics: vi.fn(),
}));
vi.mock('./api/index.ts', async () => {
  const fixtures = await import('./api/fixture-client.ts');
  return {
    clock: fixtures.clock,
    openSocket: fixtures.openSocket,
    createClient: (...args: Parameters<typeof fixtures.createClient>) => {
      const client = fixtures.createClient(...args);
      for (const key of ['users', 'detail', 'history', 'analytics'] as const) {
        const original = client[key];
        // The spy records calls while the fixture client still supplies every response.
        Object.assign(client, {
          [key]: (...params: never[]) => {
            calls[key](...params);
            return (original as (...args: never[]) => unknown)(...params);
          },
        });
      }
      return client;
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it('renders dated fixtures years later and refreshes table, details, history and cards on the tick', async () => {
  vi.useFakeTimers({ now: new Date('2036-01-01') });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  sessionStorage.setItem('adminToken', 'demo');
  render(
    <MantineProvider>
      <Notifications />
      <App />
    </MantineProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const suspended = screen.getByRole('row', { name: /user-09/ });
  expect(
    within(suspended).getByText(/throttling suspended until/i),
  ).toBeTruthy();
  expect(within(suspended).getByText(/11:00:00 UTC \(18m\)/)).toBeTruthy();
  for (const [id, status] of [
    ['user-01', 'OK'],
    ['user-04', 'Warning'],
    ['user-06', 'Exceeded'],
  ]) {
    expect(
      within(screen.getByRole('row', { name: new RegExp(id) })).getByText(
        status,
      ),
    ).toBeTruthy();
  }
  fireEvent.click(within(suspended).getByRole('button', { name: 'user-09' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(
    within(
      screen.getByRole('region', { name: 'Recent requests' }),
    ).getAllByRole('row').length,
  ).toBeGreaterThan(1);
  expect(screen.getByText(/Admitted:.*rejected:/)).toBeTruthy();
  const counts = Object.fromEntries(
    Object.entries(calls).map(([key, spy]) => [key, spy.mock.calls.length]),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  for (const key of ['users', 'detail', 'history', 'analytics'] as const)
    expect(calls[key]).toHaveBeenCalledTimes(counts[key] + 1);
});
