import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { users } from '../fixtures/index.ts';
import { deferred } from '../lib/test-helpers.ts';
import { createClient } from './client.ts';
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

it('adds the bearer token, encodes IDs and accepts any successful HTTP status', async () => {
  fetchMock.mockResolvedValue(response(users[0], 201));
  const session = new AbortController();
  const client = createClient({
    token: 'admin',
    signal: session.signal,
    onRefused: vi.fn(),
  });
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
  const client = createClient({
    token: 'admin',
    signal: new AbortController().signal,
    onRefused,
  });
  await expect(client.users()).rejects.toMatchObject({
    status: 401,
    message: 'Not accepted',
  });
  expect(onRefused).toHaveBeenCalledOnce();
});

it.each(['session', 'request'] as const)(
  'an aborted %s drops even a late 401',
  async (kind) => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const session = new AbortController();
    const requestController = new AbortController();
    const onRefused = vi.fn();
    const client = createClient({
      token: 'admin',
      signal: session.signal,
      onRefused,
    });
    const result = client.users(requestController.signal);
    const rejected = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    const controllers = { session, request: requestController };
    controllers[kind].abort();
    pending.resolve(response({ message: 'old token' }, 401));
    await rejected;
    expect(onRefused).not.toHaveBeenCalled();
  },
);

it('drops a response aborted while its JSON body was still being read', async () => {
  const json = deferred<unknown>();
  const result = response(users);
  vi.spyOn(result, 'json').mockReturnValue(json.promise);
  fetchMock.mockResolvedValue(result);
  const controller = new AbortController();
  const client = createClient({
    token: 'admin',
    signal: controller.signal,
    onRefused: vi.fn(),
  });
  const pending = client.users();
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  await Promise.resolve();
  controller.abort();
  json.resolve(users);
  await rejected;
});

it.each(['success', 'failure', '401'] as const)(
  'an old-session admin action suppresses its late %s',
  async (outcome) => {
    const responsePending = deferred<Response>();
    fetchMock.mockReturnValue(responsePending.promise);
    const controller = new AbortController();
    const onRefused = vi.fn();
    const client = createClient({
      token: 'old',
      signal: controller.signal,
      onRefused,
    });
    const action = client.reset('user-01');
    const rejected = expect(action).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    if (outcome === 'failure')
      responsePending.reject(new TypeError('network failed'));
    else
      responsePending.resolve(
        response(
          outcome === '401' ? { message: 'old refusal' } : users[0],
          outcome === '401' ? 401 : 200,
        ),
      );
    await rejected;
    expect(onRefused).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

it('rejects a malformed successful body instead of trusting its TypeScript type', async () => {
  fetchMock.mockResolvedValue(response([{ userId: 'bad' }]));
  const client = createClient({
    token: 'admin',
    signal: new AbortController().signal,
    onRefused: vi.fn(),
  });
  await expect(client.users()).rejects.toMatchObject({
    name: 'HttpError',
    message: 'The server returned an invalid response.',
  });
});

it('still handles a 401 whose error body is not JSON', async () => {
  fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
  const onRefused = vi.fn();
  const client = createClient({
    token: 'admin',
    signal: new AbortController().signal,
    onRefused,
  });
  await expect(client.users()).rejects.toMatchObject({ status: 401 });
  expect(onRefused).toHaveBeenCalledOnce();
});

it('normalizes a network failure without a status', async () => {
  fetchMock.mockRejectedValue(new TypeError('network down'));
  const error = await request('/api/admin/users', {
    token: 'admin',
    signal: new AbortController().signal,
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toHaveProperty('status', undefined);
});

it('aborts transport after exactly 10 seconds and reports a timeout without a status', async () => {
  vi.useFakeTimers();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
  fetchMock.mockImplementation(
    (_path, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
  );
  const pending = request('/api/admin/users', {
    token: 'admin',
    signal: new AbortController().signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'HttpError',
    status: undefined,
    message: 'The request timed out after 10 seconds.',
  });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(timeout).toHaveBeenCalledWith(10_000);
});

// Each admin control and the history read must reach the route the API serves,
// with the verb and body it expects. A wrong path, verb or dropped body is
// rejected by the API (404, 405 or 400) and is invisible to every test that
// mocks the client itself.
const userPath = '/api/admin/users/user-01';
type ApiClient = ReturnType<typeof createClient>;
it.each([
  [
    'history',
    (c: ApiClient) => c.history('user-01', 'day'),
    [],
    'GET',
    `${userPath}/history?range=day`,
    undefined,
  ],
  [
    'reset',
    (c: ApiClient) => c.reset('user-01'),
    users[0],
    'POST',
    `${userPath}/reset`,
    undefined,
  ],
  [
    'suspend',
    (c: ApiClient) => c.suspend('user-01', { minutes: 30 }),
    users[0],
    'POST',
    `${userPath}/suspension`,
    '{"minutes":30}',
  ],
  [
    'unsuspend',
    (c: ApiClient) => c.unsuspend('user-01'),
    users[0],
    'DELETE',
    `${userPath}/suspension`,
    undefined,
  ],
  [
    'addExtra',
    (c: ApiClient) => c.addExtra('user-01', { amount: 25 }),
    users[0],
    'POST',
    `${userPath}/extra`,
    '{"amount":25}',
  ],
])(
  '%s sends the expected request',
  async (_name, call, body, method, path, sentBody) => {
    fetchMock.mockResolvedValue(response(body));
    await call(
      createClient({
        token: 'admin',
        signal: new AbortController().signal,
        onRefused: vi.fn(),
      }),
    );
    const [sentPath, options] = fetchMock.mock.calls[0];
    expect(sentPath).toBe(path);
    expect(options?.method).toBe(method);
    expect(options?.body).toBe(sentBody);
  },
);
