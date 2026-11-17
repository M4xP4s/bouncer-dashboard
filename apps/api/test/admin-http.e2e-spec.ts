import type { ApiError } from '@app/contracts';
import request, { type Response } from 'supertest';
import {
  ADMIN_TOKEN,
  drainEvents,
  observeDashboard,
  requestUpdatesOf,
  useFrozenApplication,
} from './support/application.js';

// One bound and one unknown key show that the validation pipe is installed;
// the string values fail only if the application converts them before it.
const INVALID_BODIES = [
  ['put', '/users/user-01/limit', { limit: 0 }],
  ['put', '/users/user-01/limit', { limit: '10' }],
  ['post', '/users/user-01/extra', { amount: '5' }],
  ['post', '/users/user-01/extra', { amount: 5, other: true }],
  ['post', '/users/user-01/suspension', { minutes: '5' }],
] as const;

const ADMIN_ROUTES = [
  ['get', '/users', undefined],
  ['get', '/users/user-01', undefined],
  ['get', '/users/user-01/history?range=hour', undefined],
  ['get', '/analytics', undefined],
  ['post', '/users/user-01/reset', undefined],
  ['put', '/users/user-01/limit', { limit: 10 }],
  ['post', '/users/user-01/suspension', { minutes: 1 }],
  ['delete', '/users/user-01/suspension', undefined],
  ['post', '/users/user-01/extra', { amount: 1 }],
] as const;

const ADMIN_ACTIONS = [
  ['post', '/users/user-01/reset', undefined, 'reset'],
  ['put', '/users/user-01/limit', { limit: 10 }, 'limit'],
  ['post', '/users/user-01/suspension', { minutes: 1 }, 'suspend'],
  ['delete', '/users/user-01/suspension', undefined, 'unsuspend'],
  ['post', '/users/user-01/extra', { amount: 2 }, 'extra'],
] as const;

function expectApiError(body: ApiError, statusCode: number) {
  expect(body.statusCode).toBe(statusCode);
  expect(body.error).toEqual(expect.any(String));
  expect(body.message).toEqual(expect.any(String));
}

describe('admin HTTP and events', () => {
  const application = useFrozenApplication();

  it('answers bad input and unknown users with an error body and changes nothing', async () => {
    const api = application();
    await api.sample().expect(200);
    const detailBefore = await api.detail();
    const keysBefore = (await api.redis.keys('*')).sort();

    const unknown = await api
      .admin('post', '/users/no-such-user/reset')
      .expect(404);
    const invalid: Response[] = [];
    for (const [method, path, body] of INVALID_BODIES)
      invalid.push(await api.admin(method, path, body).expect(400));
    const malformed = await request(api.url)
      .put('/api/admin/users/user-01/limit')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    const badRange = await api
      .admin('get', '/users/user-01/history?range=week')
      .expect(400);

    expectApiError(unknown.body, 404);
    for (const response of [...invalid, malformed, badRange])
      expectApiError(response.body, 400);
    expect((await api.redis.keys('*')).sort()).toEqual(keysBefore);
    expect(await api.detail()).toEqual(detailBefore);
    expect((await api.sample().expect(200)).headers['x-count']).toBe('98');
  });

  it.each([
    ['no token', null],
    ['a user token', 'test-token-01'],
  ])(
    'refuses every admin route and the socket with %s',
    async (_case, token) => {
      const api = application();

      for (const [method, path, body] of ADMIN_ROUTES)
        await api.admin(method, path, body, token).expect(401);

      await expect(api.dashboard(token)).rejects.toThrow('Unauthorized');
      expect(await api.redis.keys('*')).toEqual([]);
    },
  );

  it('sends the full row with a rising version for a request and every admin action', async () => {
    const api = application();
    const socket = await api.dashboard();
    const { updates } = observeDashboard(socket);

    await api.sample().expect(200);
    await drainEvents(api, socket);

    let [previous] = requestUpdatesOf(updates, 'user-01');
    if (!previous) throw new Error('Missing request update');
    expect(previous.row).toEqual((await api.detail()).row);
    expect(previous.request).toMatchObject({ outcome: 'allowed' });

    for (const [method, path, body, cause] of ADMIN_ACTIONS) {
      const response = await api.admin(method, path, body).expect(200);
      await drainEvents(api, socket);

      const event = updates.findLast(
        (item) => item.cause === cause && item.row.userId === 'user-01',
      );
      if (!event) throw new Error(`Missing ${cause} update`);
      expect(event.row).toEqual(response.body);
      expect(event.request).toBeNull();
      expect(event.row.version).toBeGreaterThan(previous.row.version);
      previous = event;
    }
  });

  it('keeps an ID with uppercase, underscore and hyphen intact on every route', async () => {
    const api = application();
    const userId = 'User_06-TEST';

    const admitted = await api.sample('test-token-06').expect(200);
    const row = await api.snapshotRow(userId);
    const detail = await api.detail(userId);
    const changed = await api
      .admin('put', `/users/${userId}/limit`, { limit: 20 })
      .expect(200);

    expect(admitted.body.userId).toBe(userId);
    expect(row).toMatchObject({ userId, used: 1 });
    expect(detail.row.userId).toBe(userId);
    expect(changed.body.userId).toBe(userId);
  });
});
