import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../../api/client.ts';
import { openSocket } from '../../api/index.ts';
import type { Session } from '../../api/useSession.ts';
import { analytics, NOW, users } from '../../fixtures/index.ts';
import { mockSocket } from '../../lib/test-helpers.ts';
import { useLiveUsers } from '../../live/useLiveUsers.ts';
import { AnalyticsCards } from './AnalyticsCards.tsx';

vi.mock('../../api/index.ts', () => ({
  openSocket: vi.fn(),
  clock: () => Date.now(),
}));

// Both the HTTP timeout and the interval between refreshes.
const TEN_SECONDS_MS = 10_000;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW) });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function LiveAnalytics({ session }: { session: Session }) {
  const live = useLiveUsers(session);
  return <AnalyticsCards session={session} tick={live.tick} />;
}

function renderLiveAnalytics() {
  const { signal } = new AbortController();
  const onRefused = vi.fn();
  const session: Session = {
    token: 'demo',
    signal,
    onRefused,
    client: createClient({ token: 'demo', signal, onRefused }),
  };
  render(<LiveAnalytics session={session} />, { wrapper: MantineProvider });
}

/** Timeout signals follow the fake timers, so the real client code runs. */
function stubTimeoutSignals() {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      milliseconds,
    );
    return controller.signal;
  });
}

const jsonResponse = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body)));

/** A request that never answers: it fails only when its signal aborts. */
const hangUntilAborted = (signal?: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

/** The users request always answers; analytics hangs until `recover()`. */
function stubFetch() {
  let analyticsAnswers = false;
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation((path, options) => {
      if (path === '/api/admin/users') return jsonResponse(users);
      if (analyticsAnswers) return jsonResponse(analytics);
      return hangUntilAborted(options?.signal);
    });
  vi.stubGlobal('fetch', fetchMock);
  return {
    analyticsRequests: () =>
      fetchMock.mock.calls.filter(([path]) => path === '/api/admin/analytics'),
    recover: () => {
      analyticsAnswers = true;
    },
  };
}

const advance = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

it('keeps a 10-second HTTP timeout visible through the queued refresh until recovery', async () => {
  stubTimeoutSignals();
  const api = stubFetch();
  const socket = mockSocket();
  vi.mocked(openSocket).mockReturnValue(socket);
  renderLiveAnalytics();

  await act(async () =>
    socket.listeners.connect.forEach((listener) => listener()),
  );
  expect(api.analyticsRequests()).toHaveLength(1);

  await advance(TEN_SECONDS_MS);
  expect(api.analyticsRequests()).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toContain(
    'The request timed out after 10 seconds.',
  );

  await advance(TEN_SECONDS_MS - 1);
  expect(screen.getByRole('alert').textContent).toContain(
    'The request timed out after 10 seconds.',
  );

  api.recover();
  await advance(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('64%')).toBeTruthy();
});
