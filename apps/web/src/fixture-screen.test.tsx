import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Client, ClientOptions } from './api/client.ts';
import App from './App.tsx';

const loads = vi.hoisted(() => ({
  users: vi.fn(),
  detail: vi.fn(),
  history: vi.fn(),
  analytics: vi.fn(),
}));
vi.mock('./api/index.ts', async () => {
  const fixtures = await import('./api/fixture-client.ts');
  /** Counts a load, then lets the fixture client answer it. */
  const counted =
    <Args extends unknown[], Result>(
      count: () => void,
      load: (...args: Args) => Result,
    ) =>
    (...args: Args) => {
      count();
      return load(...args);
    };
  return {
    clock: fixtures.clock,
    openSocket: fixtures.openSocket,
    createClient: (options: ClientOptions): Client => {
      const client = fixtures.createClient(options);
      return {
        ...client,
        users: counted(loads.users, client.users),
        detail: counted(loads.detail, client.detail),
        history: counted(loads.history, client.history),
        analytics: counted(loads.analytics, client.analytics),
      };
    },
  };
});

// The interval at which the dashboard reconciles while the page is visible.
const TICK_MS = 10_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const advance = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

const tableRow = (userId: string) =>
  within(screen.getByRole('row', { name: new RegExp(userId) }));

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
  // Covers connecting, the first loads and the refresh queued behind them.
  await advance(400);

  const suspended = tableRow('user-09');
  expect(suspended.getByText(/throttling suspended until/i)).toBeTruthy();
  expect(suspended.getByText(/11:00:00 UTC \(18m\)/)).toBeTruthy();
  expect(tableRow('user-01').getByText('OK')).toBeTruthy();
  expect(tableRow('user-04').getByText('Warning')).toBeTruthy();
  expect(tableRow('user-06').getByText('Exceeded')).toBeTruthy();
  const status = within(screen.getByRole('radiogroup', { name: 'Status' }));
  expect(
    status
      .getAllByRole<HTMLInputElement>('radio')
      .map((radio) => radio.labels?.[0]?.textContent),
  ).toEqual(['All 12', 'Exceeded 3', 'Warning 4', 'OK 5']);

  fireEvent.click(suspended.getByRole('button', { name: 'user-09' }));
  // The fixture client replies after 150 ms.
  await advance(200);
  const recentRequests = within(
    screen.getByRole('region', { name: 'Recent requests' }),
  );
  expect(recentRequests.getAllByRole('row').length).toBeGreaterThan(1);
  expect(screen.getByText(/Admitted:.*rejected:/)).toBeTruthy();

  vi.clearAllMocks();
  await advance(TICK_MS);
  await advance(200);

  expect(loads.users).toHaveBeenCalledTimes(1);
  expect(loads.detail).toHaveBeenCalledTimes(1);
  expect(loads.history).toHaveBeenCalledTimes(1);
  expect(loads.analytics).toHaveBeenCalledTimes(1);
});
