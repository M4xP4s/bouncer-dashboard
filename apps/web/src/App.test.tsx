import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUpdate } from './fixtures/index.ts';
import App from './App.tsx';

/**
 * A stand-in for the Socket.IO client: it records what the page asked for
 * and lets a test deliver the events a server would send.
 */
const socket = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    /** False once the server has refused the handshake. */
    active: true,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    disconnect: vi.fn(),
    /** Delivers an event to the page, as the server would. */
    receive(event: string, ...args: unknown[]) {
      act(() => listeners.get(event)?.forEach((listener) => listener(...args)));
    },
  };
});
const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));
vi.mock('./api/client.ts', () => ({
  createClient: () => ({
    users: () => new Promise(() => {}),
    analytics: () => new Promise(() => {}),
  }),
}));

beforeEach(() => {
  sessionStorage.clear();
  socket.listeners.clear();
  socket.active = true;
  vi.clearAllMocks();
  io.mockReturnValue(socket);
});
afterEach(() => vi.unstubAllGlobals());

const renderApp = () =>
  render(
    <MantineProvider>
      <App />
    </MantineProvider>,
  );

/** Enters the admin token and opens the dashboard. */
function signIn(token = 'demo-admin-token') {
  fireEvent.change(screen.getByLabelText(/admin token/i), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
}

it('asks for the admin token first and says it is demo authentication', () => {
  renderApp();

  expect(screen.getByLabelText(/admin token/i)).toBeTruthy();
  expect(screen.getByText(/demo authentication/i)).toBeTruthy();
  expect(io).not.toHaveBeenCalled();
});

it('connects with the token in the handshake, on its own origin', () => {
  renderApp();
  signIn('demo-admin-token');

  // No URL: the same page works behind Vite's proxy and served by the API.
  expect(io).toHaveBeenCalledExactlyOnceWith({
    auth: { token: 'demo-admin-token' },
  });
});

it('shows a row when rate:update arrives, with the values the server sent', () => {
  renderApp();
  signIn();
  socket.receive('connect');
  expect(screen.getByText('Loading users…')).toBeTruthy();

  socket.receive('rate:update', requestUpdate);

  const headers = screen
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
  expect(headers).toEqual([
    'User ID',
    'Remaining / Total',
    'Reset Time',
    'Status',
    'Last Request',
  ]);
  const row = screen.getByRole('row', { name: /user-01/ });
  const cells = within(row)
    .getAllByRole('cell')
    .map((td) => td.textContent);
  expect(cells).toEqual([
    'user-01',
    '87 / 100',
    expect.stringMatching(/^11:00:00 UTC/),
    'OK',
    '10:42:01 UTC',
  ]);
});

it('keeps the newer row when an older event arrives late', () => {
  renderApp();
  signIn();
  socket.receive('rate:update', requestUpdate);

  const late = {
    ...requestUpdate,
    row: { ...requestUpdate.row, version: 12, remaining: 88 },
  };
  socket.receive('rate:update', late);

  expect(screen.getByText('87 / 100')).toBeTruthy();
});

it('says when the data last changed, not only that it is connected', () => {
  renderApp();
  signIn();
  expect(screen.getByText(/connecting/i)).toBeTruthy();

  socket.receive('connect');
  expect(screen.getByRole('status').textContent).toBe('Live');
  expect(screen.getByText('No update yet')).toBeTruthy();

  socket.receive('rate:update', requestUpdate);
  expect(screen.getByText('Last update 10:42:01 UTC')).toBeTruthy();

  socket.receive('disconnect');
  expect(screen.getByText(/disconnected/i)).toBeTruthy();
});

it('returns to the token field when the server refuses the token', () => {
  renderApp();
  signIn('wrong-token');

  socket.active = false;
  socket.receive('connect_error', new Error('Unauthorized'));

  expect(screen.getByLabelText(/admin token/i)).toBeTruthy();
  expect(screen.getByText('The admin token was not accepted.')).toBeTruthy();
  expect(sessionStorage.getItem('adminToken')).toBeNull();
});

it('keeps the token for the browser session', () => {
  sessionStorage.setItem('adminToken', 'demo-admin-token');

  renderApp();

  expect(io).toHaveBeenCalledExactlyOnceWith({
    auth: { token: 'demo-admin-token' },
  });
});

it('still opens when the browser blocks storage; the token is then kept in memory', () => {
  // Blocked site data and sandboxed frames make every storage call throw.
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.stubGlobal('sessionStorage', {
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
  });

  renderApp();
  signIn();

  expect(screen.getByRole('status')).toBeTruthy();

  socket.active = false;
  socket.receive('connect_error', new Error('Unauthorized'));

  expect(screen.getByText('The admin token was not accepted.')).toBeTruthy();
});

it('removes only its own listeners and disconnects when it goes away', () => {
  const { unmount } = renderApp();
  signIn();
  const added = [...socket.on.mock.calls];

  unmount();

  // The same functions that were added, so no other listener is touched.
  expect(socket.off.mock.calls).toEqual(added);
  expect(socket.disconnect).toHaveBeenCalledOnce();
});
