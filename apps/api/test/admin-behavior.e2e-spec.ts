import {
  MINUTE_MS,
  NEXT_HOUR,
  SECOND_MS,
  TEST_NOW,
  useFrozenApplication,
} from './support/application.js';

describe('admin quota behavior', () => {
  const application = useFrozenApplication();

  it('resets usage and grant but keeps the default limit', async () => {
    const api = application();
    await api.admitInTurn(100);
    vi.setSystemTime(TEST_NOW + SECOND_MS);

    const reset = await api.admin('post', '/users/user-01/reset').expect(200);
    const next = await api.sample().expect(200);

    expect(reset.body).toMatchObject({
      used: 0,
      limit: 100,
      extra: 0,
      lastResetAt: new Date(TEST_NOW + SECOND_MS).toISOString(),
    });
    expect(next.headers['x-count']).toBe('99');
  });

  it('resets usage and grant but keeps a custom limit', async () => {
    const api = application();
    await api.admin('put', '/users/user-02/limit', { limit: 10 }).expect(200);
    await api.admin('post', '/users/user-02/extra', { amount: 5 }).expect(200);
    await api.admitInTurn(15, 'test-token-02');
    await api.sample('test-token-02').expect(429);
    vi.setSystemTime(TEST_NOW + 2 * SECOND_MS);

    const reset = await api.admin('post', '/users/user-02/reset').expect(200);
    const next = await api.sample('test-token-02').expect(200);

    expect(reset.body).toMatchObject({
      used: 0,
      limit: 10,
      extra: 0,
      lastResetAt: new Date(TEST_NOW + 2 * SECOND_MS).toISOString(),
    });
    expect(next.headers['x-count']).toBe('9');
  });

  it('keeps usage when the limit changes, even below the current count', async () => {
    const api = application();
    await api.admitInTurn(30);

    const lowered = await api
      .admin('put', '/users/user-01/limit', { limit: 10 })
      .expect(200);
    await api.sample().expect(429);
    const usedAfterRejection = (await api.detail()).row.used;
    const raised = await api
      .admin('put', '/users/user-01/limit', { limit: 200 })
      .expect(200);
    const next = await api.sample().expect(200);

    expect(lowered.body).toMatchObject({ used: 30, limit: 10, remaining: 0 });
    expect(usedAfterRejection).toBe(30);
    expect(raised.body).toMatchObject({ used: 30, limit: 200, remaining: 170 });
    expect(next.headers['x-count']).toBe('169');
  });

  it('adds exactly five slots with a grant, which ends at the hour', async () => {
    const api = application();
    await api.admitInTurn(100);

    const grant = await api
      .admin('post', '/users/user-01/extra', { amount: 5 })
      .expect(200);

    expect(grant.body).toMatchObject({
      used: 100,
      limit: 100,
      extra: 5,
      remaining: 5,
    });
    for (let remaining = 4; remaining >= 0; remaining--) {
      const response = await api.sample().expect(200);
      expect(response.headers['x-count']).toBe(String(remaining));
    }
    await api.sample().expect(429);

    vi.setSystemTime(NEXT_HOUR);
    const nextHour = await api.sample().expect(200);

    expect(nextHour.headers['x-count']).toBe('99');
    expect((await api.detail()).row).toMatchObject({
      used: 1,
      limit: 100,
      extra: 0,
    });
  });

  it('admits and counts requests while suspended, until the suspension expires or is lifted', async () => {
    const api = application();
    await api.admitInTurn(100);
    const suspend = () =>
      api
        .admin('post', '/users/user-01/suspension', { minutes: 2 })
        .expect(200);

    await suspend();
    const atStart = await api.sample().expect(200);
    vi.setSystemTime(TEST_NOW + 2 * MINUTE_MS - 1);
    const atEnd = await api.sample().expect(200);
    const usedWhileSuspended = (await api.detail()).row.used;
    vi.setSystemTime(TEST_NOW + 2 * MINUTE_MS);
    await api.sample().expect(429);

    expect(atStart.headers['x-count']).toBe('0');
    expect(atEnd.headers['x-count']).toBe('0');
    expect(usedWhileSuspended).toBe(102);

    await suspend();
    await api.sample().expect(200);
    await api.admin('delete', '/users/user-01/suspension').expect(200);
    await api.sample().expect(429);

    expect((await api.detail()).row.used).toBe(103);
  });
});
