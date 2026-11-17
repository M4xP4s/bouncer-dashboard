import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function LiveAnalytics({ session }: { session: Session }) {
  const live = useLiveUsers(session);
  return <AnalyticsCards session={session} tick={live.tick} />;
}

it('keeps a 10-second HTTP timeout visible through the queued refresh until recovery', async () => {
  vi.useFakeTimers({ now: Date.parse(NOW) });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  // Drive timeout signals with fake timers while retaining the actual transport/client code.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      milliseconds,
    );
    return controller.signal;
  });
  let recovered = false;
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation((path, options) => {
      if (path === '/api/admin/users')
        return Promise.resolve(new Response(JSON.stringify(users)));
      if (recovered)
        return Promise.resolve(new Response(JSON.stringify(analytics)));
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    });
  vi.stubGlobal('fetch', fetchMock);
  const socket = mockSocket();
  vi.mocked(openSocket).mockReturnValue(socket);
  const controller = new AbortController();
  const onRefused = vi.fn();
  const session: Session = {
    token: 'demo',
    signal: controller.signal,
    onRefused,
    client: createClient({
      token: 'demo',
      signal: controller.signal,
      onRefused,
    }),
  };
  const view = render(
    <MantineProvider>
      <LiveAnalytics session={session} />
    </MantineProvider>,
  );
  try {
    await act(async () =>
      socket.listeners.connect.forEach((listener) => listener()),
    );
    expect(
      fetchMock.mock.calls.filter(([path]) => path === '/api/admin/analytics'),
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      fetchMock.mock.calls.filter(([path]) => path === '/api/admin/analytics'),
    ).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toContain(
      'The request timed out after 10 seconds.',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'The request timed out after 10 seconds.',
    );
    recovered = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('64%')).toBeTruthy();
  } finally {
    view.unmount();
    controller.abort();
  }
});
