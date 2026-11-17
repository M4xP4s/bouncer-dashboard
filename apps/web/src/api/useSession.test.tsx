import { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import { fireEvent } from '@testing-library/react';
import { AdminForms } from '../features/admin/AdminForms.tsx';
import type { LiveUsers } from '../live/useLiveUsers.ts';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analytics, users } from '../fixtures/index.ts';
import { deferred, mockSocket } from '../lib/test-helpers.ts';
import { useRequest } from '../lib/useRequest.ts';
import { useLiveUsers } from '../live/useLiveUsers.ts';
import { createClient, openSocket } from './index.ts';
import { useSession, type Session } from './useSession.ts';

vi.mock('./index.ts', async () => {
  const real = await import('./client.ts');
  return {
    createClient: vi.fn(real.createClient),
    openSocket: vi.fn(),
    clock: () => Date.now(),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const requests: {
  token: string;
  path: string;
  response: ReturnType<typeof deferred<Response>>;
  signal: AbortSignal | null | undefined;
}[] = [];
const sockets: ReturnType<typeof mockSocket>[] = [];

beforeEach(() => {
  requests.length = 0;
  sockets.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((path, options) => {
    const response = deferred<Response>();
    const headers = new Headers(options?.headers);
    requests.push({
      token: headers.get('Authorization') ?? '',
      path: String(path),
      response,
      signal: options?.signal,
    });
    return response.promise;
  });
  vi.mocked(openSocket).mockImplementation(() => {
    const socket = mockSocket();
    sockets.push(socket);
    return socket;
  });
});
afterEach(() => vi.unstubAllGlobals());

function SessionHost({
  token,
  onRefused,
}: {
  token: string;
  onRefused: () => void;
}) {
  const session = useSession(token, onRefused);
  return session ? <Panels session={session} /> : null;
}

function Panels({ session }: { session: Session }) {
  const live = useLiveUsers(session);
  const detail = useRequest(
    'detail:user-01',
    (signal) => session.client.detail('user-01', signal),
    live.tick,
  );
  const cards = useRequest(
    'analytics',
    (signal) => session.client.analytics(signal),
    live.tick,
  );
  return (
    <div>
      <span>session {session.token}</span>
      <span>rows {[...live.rows.keys()].join(',')}</span>
      <span>detail {detail.data?.row.userId}</span>
      <span>analytics {cards.data?.totalUsers}</span>
      <span>
        {detail.error?.message}
        {cards.error?.message}
        {live.snapshot.error?.message}
      </span>
    </div>
  );
}

function body(path: string, owner: string): unknown {
  const row = { ...users[0], userId: `${owner}-row` };
  if (path.endsWith('/analytics'))
    return { ...analytics, totalUsers: owner === 'new' ? 42 : 99 };
  if (path.endsWith('/users')) return [row];
  return { row, recentRequests: [] };
}

it.each(['success', '401', 'failure'] as const)(
  'old snapshot/detail/analytics %s responses cannot affect the new token',
  async (outcome) => {
    const refuse = vi.fn();
    const view = render(
      <SessionHost key="old" token="old" onRefused={refuse} />,
    );
    await act(async () =>
      sockets[0].listeners.connect.forEach((listener) => listener()),
    );
    const oldRequests = requests.filter(
      (entry) => entry.token === 'Bearer old',
    );
    expect(oldRequests.map((entry) => entry.path).sort()).toEqual([
      '/api/admin/analytics',
      '/api/admin/users',
      '/api/admin/users/user-01',
    ]);
    view.rerender(<SessionHost key="new" token="new" onRefused={refuse} />);
    await act(async () =>
      sockets[1].listeners.connect.forEach((listener) => listener()),
    );
    await act(async () => {
      for (const entry of requests.filter(
        (item) => item.token === 'Bearer new',
      )) {
        entry.response.resolve(
          new Response(JSON.stringify(body(entry.path, 'new'))),
        );
      }
    });
    // Connect queues one follow-up panel refresh if its first load is pending.
    await act(async () => {
      for (const entry of requests.filter(
        (item) => item.token === 'Bearer new',
      )) {
        entry.response.resolve(
          new Response(JSON.stringify(body(entry.path, 'new'))),
        );
      }
    });
    await act(async () => {
      for (const entry of oldRequests) {
        expect(entry.signal?.aborted).toBe(true);
        if (outcome === 'failure')
          entry.response.reject(new TypeError('old network failure'));
        else
          entry.response.resolve(
            new Response(
              JSON.stringify(
                outcome === '401'
                  ? { message: 'old refusal' }
                  : body(entry.path, 'old'),
              ),
              { status: outcome === '401' ? 401 : 200 },
            ),
          );
      }
    });
    expect(screen.getByText('session new')).toBeTruthy();
    expect(screen.getByText('rows new-row')).toBeTruthy();
    expect(screen.getByText('detail new-row')).toBeTruthy();
    expect(screen.getByText('analytics 42')).toBeTruthy();
    expect(
      screen.queryByText(
        /old-row|old refusal|old network failure|analytics 99/,
      ),
    ).toBeNull();
    expect(refuse).not.toHaveBeenCalled();
    expect(
      requests.filter((entry) => entry.token === 'Bearer old'),
    ).toHaveLength(3);
  },
);

it('StrictMode creates a fresh live controller after effect cleanup', () => {
  const view = render(
    <StrictMode>
      <SessionHost key="admin" token="admin" onRefused={vi.fn()} />
    </StrictMode>,
  );
  const sessions = vi
    .mocked(createClient)
    .mock.calls.map(([options]) => options.signal);
  expect(sessions).toHaveLength(2);
  expect(sessions[0].aborted).toBe(true);
  expect(sessions[1].aborted).toBe(false);
  expect(screen.getByText('session admin')).toBeTruthy();
  view.unmount();
  expect(sessions[1].aborted).toBe(true);
});

it('aborts the session before reporting a refusal', () => {
  const refused = vi.fn();
  const { result } = renderHook(() => useSession('admin', refused));
  const session = result.current!;
  refused.mockImplementation(() => expect(session.signal.aborted).toBe(true));
  act(() => session.onRefused());
  expect(refused).toHaveBeenCalledOnce();
  act(() => session.onRefused());
  expect(refused).toHaveBeenCalledOnce();
});

it('a current action 401 aborts before the action can refresh, apply or show an error', async () => {
  const refused = vi.fn();
  const live = { refresh: vi.fn(), applyRow: vi.fn() } as unknown as LiveUsers;
  function Host() {
    const session = useSession('admin', refused);
    return (
      session && <AdminForms userId="user-01" session={session} live={live} />
    );
  }
  render(
    <MantineProvider>
      <Host />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  await act(async () =>
    requests[0].response.resolve(
      new Response(JSON.stringify({ message: 'refused' }), { status: 401 }),
    ),
  );
  expect(refused).toHaveBeenCalledOnce();
  expect(live.refresh).not.toHaveBeenCalled();
  expect(live.applyRow).not.toHaveBeenCalled();
  expect(screen.queryByText('refused')).toBeNull();
});

it('a late action 401 from a replaced token does not refuse the new session or update it', async () => {
  const refused = vi.fn();
  const live = { refresh: vi.fn(), applyRow: vi.fn() } as unknown as LiveUsers;
  function Host({ token }: { token: string }) {
    const session = useSession(token, refused);
    return (
      session && <AdminForms userId="user-01" session={session} live={live} />
    );
  }
  const view = render(
    <MantineProvider>
      <Host key="old" token="old" />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));
  view.rerender(
    <MantineProvider>
      <Host key="new" token="new" />
    </MantineProvider>,
  );
  await act(async () =>
    requests[0].response.resolve(
      new Response(JSON.stringify({ message: 'old refusal' }), { status: 401 }),
    ),
  );
  expect(refused).not.toHaveBeenCalled();
  expect(live.refresh).not.toHaveBeenCalled();
  expect(live.applyRow).not.toHaveBeenCalled();
  expect(screen.queryByText('old refusal')).toBeNull();
});
