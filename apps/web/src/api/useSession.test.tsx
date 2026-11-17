import { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminForms } from '../features/admin/AdminForms.tsx';
import { analytics, NOW, users } from '../fixtures/index.ts';
import { deferred, mockSocket } from '../lib/test-helpers.ts';
import { useRequest } from '../lib/useRequest.ts';
import { useLiveUsers, type LiveUsers } from '../live/useLiveUsers.ts';
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

/** A fetch call the test answers when it chooses. */
interface PendingRequest {
  authorization: string;
  path: string;
  response: ReturnType<typeof deferred<Response>>;
  signal: AbortSignal | null | undefined;
}
type LateOutcome = 'success' | '401' | 'failure';

const fetchMock = vi.fn<typeof fetch>();
const requests: PendingRequest[] = [];
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
      authorization: headers.get('Authorization') ?? '',
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

function FormsHost({
  token,
  onRefused,
  live,
}: {
  token: string;
  onRefused: () => void;
  live: LiveUsers;
}) {
  const session = useSession(token, onRefused);
  return (
    session && <AdminForms userId="user-01" session={session} live={live} />
  );
}

function mockLive(): LiveUsers {
  return {
    rows: new Map(),
    liveRecords: new Map(),
    connection: 'live',
    lastUpdateAt: null,
    snapshot: { status: 'loaded', error: null },
    now: 0,
    tick: 0,
    applyRow: vi.fn(),
    refresh: vi.fn(),
  };
}

/** The body for a path; its row ID and user count tell the tokens apart. */
function body(path: string, owner: 'old' | 'new'): unknown {
  const row = { ...users[0], userId: `${owner}-row` };
  if (path.endsWith('/analytics'))
    return { ...analytics, totalUsers: owner === 'new' ? 42 : 99 };
  if (path.endsWith('/users')) {
    return {
      rows: [row],
      total: 1,
      page: 1,
      pageSize: 50,
      startedAt: NOW,
      completedAt: NOW,
    };
  }
  return { row, recentRequests: [] };
}

const jsonResponse = (content: unknown, status = 200) =>
  new Response(JSON.stringify(content), { status });

const requestsSentWith = (authorization: string) =>
  requests.filter((request) => request.authorization === authorization);

const connect = (socket: ReturnType<typeof mockSocket>) =>
  act(async () => socket.listeners.connect.forEach((listener) => listener()));

const answerNewRequests = () =>
  act(async () =>
    requestsSentWith('Bearer new').forEach((request) =>
      request.response.resolve(jsonResponse(body(request.path, 'new'))),
    ),
  );

function settleLate(request: PendingRequest, outcome: LateOutcome) {
  if (outcome === 'failure') {
    request.response.reject(new TypeError('old network failure'));
    return;
  }
  if (outcome === '401') {
    request.response.resolve(jsonResponse({ message: 'old refusal' }, 401));
    return;
  }
  request.response.resolve(jsonResponse(body(request.path, 'old')));
}

const pressResetUsage = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Reset usage' }));

it.each(['success', '401', 'failure'] as const)(
  'old snapshot/detail/analytics %s responses cannot affect the new token',
  async (outcome) => {
    const refuse = vi.fn();
    const view = render(
      <SessionHost key="old" token="old" onRefused={refuse} />,
    );
    await connect(sockets[0]);
    const oldRequests = requestsSentWith('Bearer old');
    expect(oldRequests.map((request) => request.path).sort()).toEqual([
      '/api/admin/analytics',
      '/api/admin/users',
      '/api/admin/users/user-01',
    ]);

    view.rerender(<SessionHost key="new" token="new" onRefused={refuse} />);
    await connect(sockets[1]);
    await answerNewRequests();
    // Connect queues one follow-up panel refresh if its first load is pending.
    await answerNewRequests();

    expect(oldRequests.map((request) => request.signal?.aborted)).toEqual([
      true,
      true,
      true,
    ]);
    await act(async () =>
      oldRequests.forEach((request) => settleLate(request, outcome)),
    );

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
    expect(requestsSentWith('Bearer old')).toHaveLength(3);
  },
);

it('StrictMode creates a fresh live controller after effect cleanup', () => {
  const view = render(
    <StrictMode>
      <SessionHost key="admin" token="admin" onRefused={vi.fn()} />
    </StrictMode>,
  );
  const signals = vi
    .mocked(createClient)
    .mock.calls.map(([options]) => options.signal);

  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(screen.getByText('session admin')).toBeTruthy();

  view.unmount();
  expect(signals[1].aborted).toBe(true);
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
  const live = mockLive();
  render(<FormsHost token="admin" onRefused={refused} live={live} />, {
    wrapper: MantineProvider,
  });

  pressResetUsage();
  const [resetRequest] = requests;
  await act(async () =>
    resetRequest.response.resolve(jsonResponse({ message: 'refused' }, 401)),
  );

  expect(refused).toHaveBeenCalledOnce();
  expect(live.refresh).not.toHaveBeenCalled();
  expect(live.applyRow).not.toHaveBeenCalled();
  expect(screen.queryByText('refused')).toBeNull();
});

it('a late action 401 from a replaced token does not refuse the new session or update it', async () => {
  const refused = vi.fn();
  const live = mockLive();
  const view = render(
    <FormsHost key="old" token="old" onRefused={refused} live={live} />,
    { wrapper: MantineProvider },
  );

  pressResetUsage();
  const [oldResetRequest] = requests;
  view.rerender(
    <FormsHost key="new" token="new" onRefused={refused} live={live} />,
  );
  await act(async () =>
    oldResetRequest.response.resolve(
      jsonResponse({ message: 'old refusal' }, 401),
    ),
  );

  expect(refused).not.toHaveBeenCalled();
  expect(live.refresh).not.toHaveBeenCalled();
  expect(live.applyRow).not.toHaveBeenCalled();
  expect(screen.queryByText('old refusal')).toBeNull();
});
