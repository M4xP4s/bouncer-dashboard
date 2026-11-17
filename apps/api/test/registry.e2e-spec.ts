import type { Analytics, UsersPage } from '@app/contracts';
import { APP_CONFIG, type AppConfig } from '../src/config/config.js';
import {
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../src/redis/redis.module.js';
import {
  seedBatch,
  seedGeneratedUsers,
  SeedRefused,
  tokenDigest,
} from '../src/users/seed-users.js';
import { UserRegistry } from '../src/users/user-registry.js';
import {
  ADMIN_TOKEN,
  bodyOf,
  useFrozenApplication,
} from './support/application.js';

const LARGE_POPULATION_TIMEOUT_MS = 60_000;

describe('user registry and paged list', () => {
  const application = useFrozenApplication();
  // Registering watches keys, so it needs a connection of its own.
  let seedRedis: RedisClient;

  const redisUrl = () => application().app.get<AppConfig>(APP_CONFIG).redisUrl;

  beforeEach(async () => {
    seedRedis = await connectRedis(redisUrl(), 'registry-test');
  });
  afterEach(async () => {
    await closeRedis(seedRedis);
  });

  const seed = async (count: number) =>
    (await seedGeneratedUsers(seedRedis, count, ADMIN_TOKEN)).added;
  const list = (query: string) => application().usersPage(query);
  const analytics = async () =>
    bodyOf<Analytics>(
      await application().admin('get', '/analytics').expect(200),
    );
  const idsOf = (page: UsersPage) => page.rows.map((row) => row.userId);

  it(
    'registers 10000 users; a rerun or a smaller count adds nothing and keeps tokens, usage and limit',
    async () => {
      const api = application();
      await api.sample().expect(200);
      await api
        .admin('put', '/users/user-01/limit', { limit: 123 })
        .expect(200);
      const before = await api.detail();

      // user-01 to user-05 are already registered from DEMO_USERS.
      expect(await seed(10000)).toBe(9995);
      expect(await seed(10000)).toBe(0);
      expect(await seed(1000)).toBe(0);

      expect(await seedRedis.zCard('rl:registry:ids')).toBe(10001);
      expect(await seedRedis.hLen('rl:registry:tokens')).toBe(10001);
      expect(await seedRedis.hGet('rl:registry:users', 'user-01')).toBe(
        tokenDigest('test-token-01'),
      );
      expect(await api.detail()).toEqual(before);
      await api.sample('demo-token-01').expect(401);
      await api.sample('test-token-01').expect(200);
      await api.sample('demo-token-10000').expect(200);
    },
    LARGE_POPULATION_TIMEOUT_MS,
  );

  it(
    'pages 10001 users in plain string order of the ID, past the last page included',
    async () => {
      await seed(10000);
      const ids = await seedRedis.zRange('rl:registry:ids', 0, -1);

      const first = await list('page=1&pageSize=100');
      expect(idsOf(first).slice(0, 3)).toEqual([
        'User_06-TEST',
        'user-01',
        'user-02',
      ]);
      for (const page of [1, 50, 101, 102]) {
        const body = await list(`page=${page}&pageSize=100`);
        expect(idsOf(body)).toEqual(ids.slice((page - 1) * 100, page * 100));
        expect(body).toMatchObject({ total: 10001, page, pageSize: 100 });
      }
      expect(idsOf(await list('page=101&pageSize=100'))).toEqual(['user-9999']);
      expect((await list('page=102&pageSize=100')).rows).toEqual([]);
      // No route returns a token or its digest.
      expect(JSON.stringify(first)).not.toMatch(/token/i);
    },
    LARGE_POPULATION_TIMEOUT_MS,
  );

  it('filters status, last activity and search over every user before the page is cut', async () => {
    const api = application();
    await seed(1000);
    await api.admin('put', '/users/user-999/limit', { limit: 1 }).expect(200);
    await api.sample('demo-token-999').expect(200);
    await api.sample('demo-token-999').expect(429);

    const exceeded = await list('status=Exceeded&active=5m&pageSize=1');
    expect(idsOf(exceeded)).toEqual(['user-999']);
    expect(exceeded.total).toBe(1);
    expect((await list('active=24h')).total).toBe(1);
    // user-99 and user-990 to user-999, whatever the case of the search.
    const found = await list('search=USER-99&pageSize=2&page=2');
    expect(found.total).toBe(11);
    expect(idsOf(found)).toEqual(['user-991', 'user-992']);
  });

  it('counts every registered user in analytics, whatever page was read', async () => {
    const api = application();
    await seed(1000);
    await api.admin('put', '/users/user-999/limit', { limit: 1 }).expect(200);
    await api.sample('demo-token-999').expect(200);
    await api.sample('demo-token-999').expect(429);

    const before = await analytics();
    expect(before).toMatchObject({
      totalUsers: 1001,
      activeUsers: 1,
      nearLimitPercent: 100,
      denied429Today: 1,
      topUsers: [{ userId: 'user-999', used: 1, total: 1 }],
    });
    await list('page=12&pageSize=50&status=OK');
    expect(await analytics()).toEqual(before);
  });

  it('ends a read in batches at the last ID registered when it began', async () => {
    await seed(250);
    const late = { userId: 'zz-late', token: 'late-token' };
    const userIds: string[] = [];

    for await (const batch of application().app.get(UserRegistry).batches()) {
      if (userIds.length === 0) await seedBatch(seedRedis, [late], ADMIN_TOKEN);
      userIds.push(...batch);
    }

    // user-01 to user-250 and User_06-TEST, each once; zz-late sorts last.
    expect(userIds).toHaveLength(251);
    expect(new Set(userIds).size).toBe(251);
    expect(userIds).not.toContain('zz-late');
  });

  it('registers each user once when two writers register the same batch at once', async () => {
    const other = await connectRedis(redisUrl(), 'registry-other');
    const batch = Array.from({ length: 100 }, (_, index) => ({
      userId: `writer-${index}`,
      token: `writer-token-${index}`,
    }));
    try {
      const added = await Promise.all([
        seedBatch(seedRedis, batch, ADMIN_TOKEN),
        seedBatch(other, batch, ADMIN_TOKEN),
      ]);
      expect(added[0] + added[1]).toBe(100);
    } finally {
      await closeRedis(other);
    }
    expect(await seedRedis.zCard('rl:registry:ids')).toBe(106);
    expect(await seedRedis.hLen('rl:registry:users')).toBe(106);
    expect(await seedRedis.hLen('rl:registry:tokens')).toBe(106);
  });

  it('refuses a batch whole, keeps earlier batches, and resumes after a correction', async () => {
    const first = { userId: 'new-1', token: 'new-token-1' };
    const second = { userId: 'new-2', token: 'new-token-2' };
    await seedBatch(seedRedis, [first], ADMIN_TOKEN);

    const conflicting = { userId: 'conflict', token: first.token };
    await expect(
      seedBatch(seedRedis, [second, conflicting], ADMIN_TOKEN),
    ).rejects.toThrow(SeedRefused);
    expect(await seedRedis.hExists('rl:registry:users', 'new-2')).toBe(0);
    expect(await seedRedis.hExists('rl:registry:users', 'new-1')).toBe(1);

    const retried = { ...first, token: 'changed-token' };
    expect(await seedBatch(seedRedis, [retried, second], ADMIN_TOKEN)).toBe(1);
    expect(await seedRedis.hGet('rl:registry:users', 'new-1')).toBe(
      tokenDigest('new-token-1'),
    );
  });

  it('stops the start-up registration when a DEMO_USERS token belongs to another user', async () => {
    const api = application();
    await api.redis.flushDb();
    await seedBatch(
      seedRedis,
      [{ userId: 'other-user', token: 'test-token-03' }],
      ADMIN_TOKEN,
    );

    await expect(
      api.app.get(UserRegistry).importBootstrapUsers(),
    ).rejects.toThrow(SeedRefused);
    expect(await seedRedis.hLen('rl:registry:users')).toBe(1);
  });

  it('identifies a registered token without DEMO_USERS, and never the current admin token', async () => {
    const config = application().app.get<AppConfig>(APP_CONFIG);
    // As if the admin token had been changed to a token a user registered.
    const registry = new UserRegistry(seedRedis, {
      ...config,
      userIdByToken: new Map(),
      adminToken: 'test-token-01',
    });

    await registry.importBootstrapUsers();
    expect(await registry.identify('test-token-02')).toBe('user-02');
    expect(await registry.identify('test-token-01')).toBeNull();
    expect(await registry.exists('user-01')).toBe(true);
    expect(await registry.exists('missing')).toBe(false);
  });

  it.each([
    'page=0',
    'page=1&page=2',
    'pageSize=101',
    'status=invalid',
    'active=300000',
    'search[x]=y',
    'unknown=1',
  ])('answers 400 to the list query %s', async (query) => {
    await application().admin('get', `/users?${query}`).expect(400);
  });
});
