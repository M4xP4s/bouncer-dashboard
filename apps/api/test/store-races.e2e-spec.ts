import {
  type Admission,
  RateLimitStore,
} from '../src/rate-limit/rate-limit.store.js';
import {
  HOUR_MS,
  MINUTE_MS,
  NEXT_HOUR,
  TEST_NOW,
  useFrozenApplication,
  windowKey,
  windowStart,
} from './support/application.js';

// The store is called directly so the test chooses each request's time and
// when its bookkeeping runs.

/** Admits and records one request at `now`, as the interceptor would. */
async function admitAndRecord(store: RateLimitStore, now: number) {
  const admission = await store.admit('user-01', now);
  await store.recordOutcome('user-01', now, admission);
  return admission;
}

const outcomesOf = (admissions: Admission[], outcome: Admission['outcome']) =>
  admissions.filter((admission) => admission.outcome === outcome);

describe('interleaved store steps', () => {
  const application = useFrozenApplication();

  it('admits at most one cap per hour when clocks on both sides of the hour interleave', async () => {
    const api = application();
    const store = api.app.get(RateLimitStore);
    const before = NEXT_HOUR - 1;
    const after = NEXT_HOUR + 1;
    vi.setSystemTime(after);

    const attempts = await Promise.all(
      Array.from({ length: 300 }, async (_, index) => {
        const now = index % 2 === 0 ? before : after;
        return { now, admission: await admitAndRecord(store, now) };
      }),
    );

    for (const now of [before, after]) {
      const admissions = attempts
        .filter((attempt) => attempt.now === now)
        .map((attempt) => attempt.admission);
      const resetAt = new Date(windowStart(now) + HOUR_MS).toISOString();
      expect(outcomesOf(admissions, 'allowed')).toHaveLength(100);
      expect(outcomesOf(admissions, 'denied')).toHaveLength(50);
      for (const admission of admissions)
        expect(admission.row.resetAt).toBe(resetAt);
      expect(await api.redis.zCard(windowKey('user-01', now))).toBe(100);
      expect(await api.redis.pExpireTime(windowKey('user-01', now))).toBe(
        windowStart(now) + 2 * HOUR_MS,
      );
    }
    const requestIds = attempts.map(({ admission }) => admission.requestId);
    expect(new Set(requestIds).size).toBe(300);
  });

  it('lets a skipped rejection cleanup only lower the capacity, until a reset', async () => {
    const api = application();
    const store = api.app.get(RateLimitStore);
    await api.admitAtOnce(100);

    // This rejection's bookkeeping, which removes its entry, never runs.
    const stranded = await store.admit('user-01', TEST_NOW);
    const blocked = await admitAndRecord(store, TEST_NOW);
    const storedAfterRejections = await api.redis.zCard(windowKey('user-01'));
    const grant = await api
      .admin('post', '/users/user-01/extra', { amount: 5 })
      .expect(200);
    const afterGrant: Admission[] = [];
    for (let attempt = 0; attempt < 5; attempt++)
      afterGrant.push(await admitAndRecord(store, TEST_NOW));

    expect(stranded.outcome).toBe('denied');
    expect(blocked.outcome).toBe('denied');
    expect(storedAfterRejections).toBe(101);
    expect(grant.body).toMatchObject({ used: 101, total: 105, remaining: 4 });
    expect(afterGrant.map((admission) => admission.outcome)).toEqual([
      'allowed',
      'allowed',
      'allowed',
      'allowed',
      'denied',
    ]);
    expect(afterGrant.map((admission) => admission.row.remaining)).toEqual([
      3, 2, 1, 0, 0,
    ]);
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(105);
    expect((await api.detail()).row).toMatchObject({ used: 105, remaining: 0 });

    await api.admin('post', '/users/user-01/reset').expect(200);
    const windowKept = await api.redis.exists(windowKey('user-01'));
    const afterReset = await api.sample().expect(200);

    expect(windowKept).toBe(0);
    expect(afterReset.headers['x-count']).toBe('99');
  });

  it('orders recent requests by time, then ID, whatever order their bookkeeping finishes in', async () => {
    const api = application();
    const store = api.app.get(RateLimitStore);
    const times = [
      TEST_NOW,
      TEST_NOW + MINUTE_MS,
      TEST_NOW + 2 * MINUTE_MS,
      TEST_NOW + 2 * MINUTE_MS,
    ];
    const requests: { now: number; admission: Admission }[] = [];
    for (const now of times)
      requests.push({ now, admission: await store.admit('user-01', now) });
    const [first, second, ...tied] = requests;
    tied.sort((a, b) =>
      a.admission.requestId < b.admission.requestId ? -1 : 1,
    );
    vi.setSystemTime(TEST_NOW + 2 * MINUTE_MS);

    // Head pushes alone would list these as second, first, tied1, tied0;
    // the detail must sort them newest first, ties by ID.
    for (const { now, admission } of [...tied, first, second])
      await store.recordOutcome('user-01', now, admission);

    const expected = [...tied, second, first].map(({ now, admission }) => ({
      id: admission.requestId,
      at: new Date(now).toISOString(),
      outcome: admission.outcome,
      remaining: admission.row.remaining,
    }));
    expect((await api.detail()).recentRequests).toEqual(expected);
  });
});
