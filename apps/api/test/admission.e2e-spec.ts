import {
  NEXT_HOUR,
  REGISTRY_KEY_NAMES,
  useFrozenApplication,
  windowKey,
} from './support/application.js';

describe('admission and identity', () => {
  const application = useFrozenApplication();

  it('counts x-count down from 99 to 0, then answers a retryable 429', async () => {
    const api = application();

    for (let remaining = 99; remaining >= 0; remaining--) {
      const response = await api.sample().expect(200);
      expect(response.headers['x-count']).toBe(String(remaining));
    }
    const denied = await api.sample().expect(429);

    expect(denied.headers['x-count']).toBe('0');
    expect(denied.headers['retry-after']).toBe('1080');
    expect(denied.body).toMatchObject({
      statusCode: 429,
      retryAt: '2099-01-01T11:00:00.000Z',
      retryAfterSeconds: 1080,
    });
    expect(denied.body.message).toContain('100');
    expect(denied.body.message).toContain('11:00:00');
  });

  it('gives a new quota exactly at the UTC hour, not a millisecond before', async () => {
    const api = application();
    await api.admitInTurn(100);

    vi.setSystemTime(NEXT_HOUR - 1);
    await api.sample().expect(429);
    vi.setSystemTime(NEXT_HOUR);
    const first = await api.sample().expect(200);
    vi.setSystemTime(NEXT_HOUR + 1);
    const second = await api.sample().expect(200);

    expect(first.headers['x-count']).toBe('99');
    expect(second.headers['x-count']).toBe('98');
  });

  it('leaves another user its whole quota when one user is exhausted', async () => {
    const api = application();
    await api.admitInTurn(100);
    await api.sample().expect(429);

    const other = await api.sample('test-token-02').expect(200);

    expect(other.headers['x-count']).toBe('99');
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(100);
    expect(await api.redis.zCard(windowKey('user-02'))).toBe(1);
  });

  it('counts a request whose handler fails like one that succeeds', async () => {
    const api = application();

    await api.sample('test-token-01', '/api/sample/fail').expect(500);
    const next = await api.sample().expect(200);
    await api.admitInTurn(98);
    await api.sample('test-token-01', '/api/sample/fail').expect(429);

    expect(next.headers['x-count']).toBe('98');
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(100);
  });

  it('answers 500, not a retryable 503, when a key holds the wrong type', async () => {
    const api = application();
    await api.redis.set(windowKey('user-01'), 'not a sorted set');

    const response = await api.sample().expect(500);

    expect(response.headers['x-count']).toBeUndefined();
    expect(response.headers['retry-after']).toBeUndefined();
  });

  it('counts nothing for a refused credential and ignores a sent user ID', async () => {
    const api = application();

    await api.sample(null).set('x-user-id', 'user-02').expect(401);
    await api.sample('unknown').set('x-user-id', 'user-02').expect(401);
    const keysAfterRefusals = (await api.redis.keys('rl:*')).sort();
    const response = await api.sample().set('x-user-id', 'user-02').expect(200);

    expect(keysAfterRefusals).toEqual(REGISTRY_KEY_NAMES);
    expect(response.body.userId).toBe('user-01');
    expect(response.headers['x-count']).toBe('99');
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(1);
    expect(await api.redis.zCard(windowKey('user-02'))).toBe(0);
  });
});
