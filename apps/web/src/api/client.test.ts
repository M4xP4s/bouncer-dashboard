import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { users } from '../fixtures/index.ts';
import { deferred } from '../lib/test-helpers.ts';
import { createClient, type Client, type ClientOptions } from './client.ts';
import { HttpError, request } from './http.ts';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function adminClient(overrides: Partial<ClientOptions> = {}): Client {
  return createClient({
    token: 'admin',
    signal: new AbortController().signal,
    onRefused: vi.fn(),
    ...overrides,
  });
}

const requestUsers = () =>
  request('/api/admin/users', {
    token: 'admin',
    signal: new AbortController().signal,
  });

it('adds the bearer token, encodes IDs and accepts any successful HTTP status', async () => {
  fetchMock.mockResolvedValue(response(users[0], 201));
  const client = adminClient();

  await expect(client.setLimit('some/user', { limit: 250 })).resolves.toEqual(
    users[0],
  );

  const [path, options] = fetchMock.mock.calls[0];
  expect(path).toBe('/api/admin/users/some%2Fuser/limit');
  expect(options).toMatchObject({
    method: 'PUT',
    headers: {
      Authorization: 'Bearer admin',
      'Content-Type': 'application/json',
    },
    body: '{"limit":250}',
  });
});

it('reports an active 401 once, preserving the server message', async () => {
  fetchMock.mockResolvedValue(response({ message: 'Not accepted' }, 401));
  const onRefused = vi.fn();
  const client = adminClient({ onRefused });

  await expect(client.users()).rejects.toMatchObject({
    status: 401,
    message: 'Not accepted',
  });
  expect(onRefused).toHaveBeenCalledOnce();
});

it.each(['session', 'request'] as const)(
  'an aborted %s drops even a late 401',
  async (aborted) => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const controllers = {
      session: new AbortController(),
      request: new AbortController(),
    };
    const onRefused = vi.fn();
    const client = adminClient({
      signal: controllers.session.signal,
      onRefused,
    });

    const result = client.users(controllers.request.signal);
    const rejected = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    controllers[aborted].abort();
    pending.resolve(response({ message: 'old token' }, 401));

    await rejected;
    expect(onRefused).not.toHaveBeenCalled();
  },
);

it('drops a response aborted while its JSON body was still being read', async () => {
  const body = deferred<unknown>();
  const usersResponse = response(users);
  vi.spyOn(usersResponse, 'json').mockReturnValue(body.promise);
  fetchMock.mockResolvedValue(usersResponse);
  const session = new AbortController();
  const client = adminClient({ signal: session.signal });

  const result = client.users();
  const rejected = expect(result).rejects.toMatchObject({
    name: 'AbortError',
  });
  // One turn lets fetch settle, so the abort lands while the body is read.
  await Promise.resolve();
  session.abort();
  body.resolve(users);

  await rejected;
});

type PendingResponse = ReturnType<typeof deferred<Response>>;
it.each<[string, (pending: PendingResponse) => void]>([
  ['success', (pending) => pending.resolve(response(users[0]))],
  ['failure', (pending) => pending.reject(new TypeError('network failed'))],
  [
    '401',
    (pending) => pending.resolve(response({ message: 'old refusal' }, 401)),
  ],
])(
  'an old-session admin action suppresses its late %s',
  async (_outcome, settle) => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const session = new AbortController();
    const onRefused = vi.fn();
    const client = adminClient({
      token: 'old',
      signal: session.signal,
      onRefused,
    });

    const action = client.reset('user-01');
    const rejected = expect(action).rejects.toMatchObject({
      name: 'AbortError',
    });
    session.abort();
    settle(pending);

    await rejected;
    expect(onRefused).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

it('rejects a malformed successful body instead of trusting its TypeScript type', async () => {
  fetchMock.mockResolvedValue(response([{ userId: 'bad' }]));

  await expect(adminClient().users()).rejects.toMatchObject({
    name: 'HttpError',
    message: 'The server returned an invalid response.',
  });
});

it('still handles a 401 whose error body is not JSON', async () => {
  fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
  const onRefused = vi.fn();
  const client = adminClient({ onRefused });

  await expect(client.users()).rejects.toMatchObject({ status: 401 });
  expect(onRefused).toHaveBeenCalledOnce();
});

it('normalizes a network failure without a status', async () => {
  fetchMock.mockRejectedValue(new TypeError('network down'));

  const error = await requestUsers().catch((value: unknown) => value);

  expect(error).toBeInstanceOf(HttpError);
  expect(error).toHaveProperty('status', undefined);
});

// Fake timers do not drive the real AbortSignal.timeout; this one they do.
function timeoutSignalOnFakeTimers(milliseconds: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    milliseconds,
  );
  return controller.signal;
}

/** A server that never answers: the request ends only when it is aborted. */
const unansweredFetch: typeof fetch = (_path, options) =>
  new Promise((_resolve, reject) => {
    options?.signal?.addEventListener(
      'abort',
      () => reject(options.signal?.reason),
      { once: true },
    );
  });

it('aborts transport after exactly 10 seconds and reports a timeout without a status', async () => {
  vi.useFakeTimers();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(timeoutSignalOnFakeTimers);
  fetchMock.mockImplementation(unansweredFetch);

  const rejected = expect(requestUsers()).rejects.toMatchObject({
    name: 'HttpError',
    status: undefined,
    message: 'The request timed out after 10 seconds.',
  });
  const [, options] = fetchMock.mock.calls[0];

  await vi.advanceTimersByTimeAsync(9_999);
  expect(options?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(timeout).toHaveBeenCalledWith(10_000);
});

interface RouteCase {
  call: (client: Client) => Promise<unknown>;
  responseBody: unknown;
  method: string;
  path: string;
  sentBody: string | undefined;
}

// The API rejects a wrong path, verb or body (404, 405 or 400), and no test
// that mocks the client itself can see that.
const routes: Record<string, RouteCase> = {
  history: {
    call: (client) => client.history('user-01', 'day'),
    responseBody: [],
    method: 'GET',
    path: '/api/admin/users/user-01/history?range=day',
    sentBody: undefined,
  },
  reset: {
    call: (client) => client.reset('user-01'),
    responseBody: users[0],
    method: 'POST',
    path: '/api/admin/users/user-01/reset',
    sentBody: undefined,
  },
  suspend: {
    call: (client) => client.suspend('user-01', { minutes: 30 }),
    responseBody: users[0],
    method: 'POST',
    path: '/api/admin/users/user-01/suspension',
    sentBody: '{"minutes":30}',
  },
  unsuspend: {
    call: (client) => client.unsuspend('user-01'),
    responseBody: users[0],
    method: 'DELETE',
    path: '/api/admin/users/user-01/suspension',
    sentBody: undefined,
  },
  addExtra: {
    call: (client) => client.addExtra('user-01', { amount: 25 }),
    responseBody: users[0],
    method: 'POST',
    path: '/api/admin/users/user-01/extra',
    sentBody: '{"amount":25}',
  },
};
it.each(Object.entries(routes))(
  '%s sends the expected request',
  async (_name, { call, responseBody, method, path, sentBody }) => {
    fetchMock.mockResolvedValue(response(responseBody));

    await call(adminClient());

    const [sentPath, options] = fetchMock.mock.calls[0];
    expect(sentPath).toBe(path);
    expect(options?.method).toBe(method);
    expect(options?.body).toBe(sentBody);
  },
);
