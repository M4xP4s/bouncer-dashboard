import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NEXT_HOUR,
  REGISTRY_KEY_NAMES,
  SECOND_MS,
  type TestApplication,
  TEST_NOW,
  useFrozenApplication,
  windowStart,
} from './support/application.js';

// Redis counts a relative expiry down on its own clock while the test runs.
const RELATIVE_EXPIRY_SLACK_MS = SECOND_MS;

/** Writes every kind of key: a limit, admissions, rejections, a grant, a suspension. */
async function touchEveryKey(api: TestApplication) {
  await api.admin('put', '/users/user-01/limit', { limit: 1 }).expect(200);
  await api.sample().expect(200);
  await api.sample().expect(429);
  await api.admin('post', '/users/user-01/extra', { amount: 2 }).expect(200);
  await api.admitInTurn(2);
  await api.sample().expect(429);
  await api
    .admin('post', '/users/user-01/suspension', { minutes: 1 })
    .expect(200);
  await api.sample().expect(200);
}

describe('bounded retention and idle expiry', () => {
  const application = useFrozenApplication();

  it('gives every written key the expiry of its rule, or none for the per-user policy', async () => {
    const api = application();
    const hour = windowStart(TEST_NOW);
    const expiresAt: Record<string, number> = {
      [`rl:win:user-01:${hour}`]: hour + 2 * HOUR_MS,
      [`rl:extra:user-01:${hour}`]: hour + 2 * HOUR_MS,
      [`rl:notified:user-01:${hour}:1`]: hour + 2 * HOUR_MS,
      [`rl:notified:user-01:${hour}:2`]: hour + 2 * HOUR_MS,
      'rl:suspend:user-01': TEST_NOW + MINUTE_MS,
      [`rl:stat:user-01:${hour}`]: hour + 25 * HOUR_MS,
    };
    const lifetime: Record<string, number> = {
      'rl:hist:user-01': DAY_MS,
      'rl:denied:2099-01-01': 2 * DAY_MS,
    };
    const permanent = [
      'rl:limit:user-01',
      'rl:user:user-01',
      ...REGISTRY_KEY_NAMES,
    ];
    const started = performance.now();

    await touchEveryKey(api);

    const expectedKeys = [
      ...Object.keys(expiresAt),
      ...Object.keys(lifetime),
      ...permanent,
    ];
    expect((await api.redis.keys('*')).sort()).toEqual(expectedKeys.sort());
    for (const key of permanent)
      expect(await api.redis.pTTL(key), key).toBe(-1);
    for (const [key, at] of Object.entries(expiresAt)) {
      expect(await api.redis.pTTL(key), key).toBeGreaterThan(0);
      expect(await api.redis.pExpireTime(key), key).toBe(at);
    }
    for (const [key, ms] of Object.entries(lifetime)) {
      const ttl = await api.redis.pTTL(key);
      const elapsedMs = performance.now() - started;
      expect(ttl, key).toBeLessThanOrEqual(ms);
      expect(ttl, key).toBeGreaterThanOrEqual(
        ms - elapsedMs - RELATIVE_EXPIRY_SLACK_MS,
      );
    }
    expect(await api.redis.lLen('rl:hist:user-01')).toBe(6);
    expect(await api.redis.get('rl:denied:2099-01-01')).toBe('2');
    expect(await api.redis.hGetAll(`rl:stat:user-01:${hour}`)).toEqual({
      'a:42': '4',
      'd:42': '2',
    });
  });

  it('ends an idle suspension and an idle hour in the snapshot without a new version', async () => {
    const api = application();
    await api.sample().expect(200);
    const suspendedUntil = new Date(TEST_NOW + MINUTE_MS).toISOString();

    const suspension = await api
      .admin('post', '/users/user-01/suspension', { minutes: 1 })
      .expect(200);
    vi.setSystemTime(TEST_NOW + MINUTE_MS - 1);
    const lastSuspended = await api.snapshotRow();
    vi.setSystemTime(TEST_NOW + MINUTE_MS);
    const suspensionOver = await api.snapshotRow();
    vi.setSystemTime(NEXT_HOUR);
    const nextHour = await api.snapshotRow();

    expect(suspension.body).toMatchObject({ used: 1, suspendedUntil });
    expect(suspension.body.version).toBe(2);
    expect(lastSuspended).toMatchObject({
      used: 1,
      suspendedUntil,
      version: 2,
    });
    expect(suspensionOver).toMatchObject({
      used: 1,
      suspendedUntil: null,
      version: 2,
    });
    // The key is still there: the read itself must respect the end time.
    expect(await api.redis.exists('rl:suspend:user-01')).toBe(1);
    expect(nextHour).toMatchObject({
      used: 0,
      remaining: 100,
      suspendedUntil: null,
      version: 2,
      resetAt: new Date(NEXT_HOUR + HOUR_MS).toISOString(),
      lastResetAt: new Date(NEXT_HOUR).toISOString(),
    });
  });

  it('drops a record from the detail at exactly 24 hours while its list remains', async () => {
    const api = application();
    await api.sample().expect(200);
    const original = await api.detail();

    vi.setSystemTime(TEST_NOW + DAY_MS - 1);
    const lastMoment = await api.detail();
    vi.setSystemTime(TEST_NOW + DAY_MS);
    const dayLater = await api.detail();

    expect(original.recentRequests).toHaveLength(1);
    expect(lastMoment.recentRequests).toEqual(original.recentRequests);
    expect(dayLater.recentRequests).toEqual([]);
    expect(await api.redis.lLen('rl:hist:user-01')).toBe(1);
    expect(await api.redis.pTTL('rl:hist:user-01')).toBeGreaterThan(0);
  });
});
