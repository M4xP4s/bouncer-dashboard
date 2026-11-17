import type { UserRow } from '@app/contracts';
import {
  bodyOf,
  drainEvents,
  observeDashboard,
  requestIdsOf,
  requestUpdatesOf,
  SECOND_MS,
  statusCount,
  type TestApplication,
  useFrozenApplication,
  windowKey,
} from './support/application.js';
import { interleavedTraffic } from './support/interleaved-traffic.js';

const FLOOD_CALLERS = 20;
const FLOOD_CALLS_EACH = 50;
const NEIGHBOR_CALLS = 20;
const NEIGHBOR_LATENCY_LIMIT_MS = SECOND_MS;
const TOKEN_BY_USER = {
  'user-01': 'test-token-01',
  'user-02': 'test-token-02',
  'user-03': 'test-token-03',
};
const ADMISSIONS_PER_USER = 80;
const MAX_SNAPSHOT_READS = 500;

/** Waits for every task, then fails with the first error, if any. */
async function settleAll(tasks: Promise<unknown>[]) {
  for (const result of await Promise.allSettled(tasks))
    if (result.status === 'rejected') throw result.reason;
}

/** The stored members of user-01's current window, sorted. */
const storedRequestIds = async (api: TestApplication) =>
  (await api.redis.zRange(windowKey('user-01'), 0, -1)).sort();

describe('concurrency and atomic snapshots', () => {
  const application = useFrozenApplication();

  it('admits exactly 100 of 200 concurrent requests, each with its own x-count', async () => {
    const api = application();

    const responses = await api.sampleAtOnce(200);

    const admitted = responses.filter((response) => response.status === 200);
    expect(admitted).toHaveLength(100);
    expect(statusCount(responses, 429)).toBe(100);
    // Strings, so that a missing header cannot pass as a number.
    const counts = admitted.map((response) => response.headers['x-count']);
    const everyRemaining = Array.from({ length: 100 }, (_, n) => String(n));
    expect(counts.sort()).toEqual(everyRemaining.sort());
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(100);
    expect(await api.redis.zCard(windowKey('user-02'))).toBe(0);
  });

  it('keeps exactly the admissions after a reset that lands between two batches', async () => {
    const api = application();
    await api.admitAtOnce(90);
    const socket = await api.dashboard();
    const { updates } = observeDashboard(socket);

    const { responses, changed } = await interleavedTraffic(api.url, () =>
      api.admin('post', '/users/user-01/reset'),
    );
    await drainEvents(api, socket);

    expect(changed.status).toBe(200);
    const resetRow = bodyOf<UserRow>(changed);
    expect(resetRow).toMatchObject({ used: 0, remaining: 100, total: 100 });
    expect(statusCount(responses, 200) + statusCount(responses, 429)).toBe(50);
    const requestUpdates = requestUpdatesOf(updates, 'user-01');
    const beforeReset = requestUpdates.filter(
      (event) => event.row.version < resetRow.version,
    );
    const afterReset = requestUpdates.filter(
      (event) => event.row.version > resetRow.version,
    );
    expect(beforeReset).toHaveLength(10);
    expect(afterReset).toHaveLength(25);
    expect(requestUpdates).toHaveLength(35);
    expect(statusCount(responses, 200)).toBe(35);
    expect(await storedRequestIds(api)).toEqual(
      requestIdsOf(afterReset).sort(),
    );
    expect((await api.detail()).row.used).toBe(25);

    // Filling exactly the capacity left catches a wrong but plausible count.
    const fill = await api.sampleAtOnce(76);

    expect(statusCount(fill, 200)).toBe(75);
    expect(statusCount(fill, 429)).toBe(1);
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(100);
  });

  it('keeps every admission around a grant that lands between two batches', async () => {
    const api = application();
    const socket = await api.dashboard();
    const { updates } = observeDashboard(socket);

    const { responses, changed } = await interleavedTraffic(api.url, () =>
      api.admin('post', '/users/user-01/extra', { amount: 5 }),
    );
    await drainEvents(api, socket);

    expect(changed.status).toBe(200);
    const grantRow = bodyOf<UserRow>(changed);
    expect(grantRow).toMatchObject({
      used: 25,
      limit: 100,
      extra: 5,
      total: 105,
    });
    expect(statusCount(responses, 200)).toBe(50);
    const requestUpdates = requestUpdatesOf(updates, 'user-01');
    const beforeGrant = requestUpdates.filter(
      (event) => event.row.version < grantRow.version,
    );
    const afterGrant = requestUpdates.filter(
      (event) => event.row.version > grantRow.version,
    );
    expect(beforeGrant).toHaveLength(25);
    expect(afterGrant).toHaveLength(25);
    expect(requestUpdates).toHaveLength(50);
    expect(await storedRequestIds(api)).toEqual(
      requestIdsOf(requestUpdates).sort(),
    );
    expect((await api.detail()).row).toMatchObject({
      used: 50,
      extra: 5,
      total: 105,
      remaining: 55,
    });

    const fill = await api.sampleAtOnce(56);

    expect(statusCount(fill, 200)).toBe(55);
    expect(statusCount(fill, 429)).toBe(1);
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(105);
  });

  it('answers another user within a second each while 1000 rejections arrive', async () => {
    const api = application();
    await api.admitAtOnce(100);
    let rejected = 0;
    const floodCaller = async () => {
      for (let call = 0; call < FLOOD_CALLS_EACH; call++) {
        await api.sample().expect(429);
        rejected++;
      }
    };
    const neighbor = async () => {
      for (let call = 0; call < NEIGHBOR_CALLS; call++) {
        // Each neighbor call must overlap the flood to measure anything.
        expect(rejected).toBeLessThan(FLOOD_CALLERS * FLOOD_CALLS_EACH);
        const started = performance.now();
        const response = await api.sample('test-token-02').expect(200);
        expect(performance.now() - started).toBeLessThan(
          NEIGHBOR_LATENCY_LIMIT_MS,
        );
        expect(response.headers['x-count']).toBe(String(99 - call));
      }
    };

    // Both sides finish before the next test empties Redis, also on failure.
    await settleAll([
      ...Array.from({ length: FLOOD_CALLERS }, floodCaller),
      neighbor(),
    ]);

    expect(rejected).toBe(1000);
    expect(await api.redis.zCard(windowKey('user-01'))).toBe(100);
    expect(await api.redis.zCard(windowKey('user-02'))).toBe(20);
  }, 20_000);

  it('pairs used and version in every snapshot read during admissions', async () => {
    const api = application();
    const snapshots: UserRow[][] = [await api.snapshot()];
    let admittedCount = 0;
    const admitAll = async (token: string) => {
      for (let count = 0; count < ADMISSIONS_PER_USER; count++) {
        await api.sample(token).expect(200);
        admittedCount++;
      }
    };
    const tokens = Object.values(TOKEN_BY_USER);
    let readsDuringAdmissions = 0;
    const readWhileAdmitting = async () => {
      do {
        snapshots.push(await api.snapshot());
        readsDuringAdmissions++;
      } while (
        admittedCount < tokens.length * ADMISSIONS_PER_USER &&
        readsDuringAdmissions < MAX_SNAPSHOT_READS
      );
    };

    await settleAll([...tokens.map(admitAll), readWhileAdmitting()]);
    snapshots.push(await api.snapshot());

    const caughtMidway = snapshots.some((rows) =>
      rows.some((row) => row.used > 0 && row.used < ADMISSIONS_PER_USER),
    );
    expect(caughtMidway).toBe(true);
    for (const rows of snapshots) {
      expect(rows).toHaveLength(6);
      for (const row of rows)
        expect(row.used, JSON.stringify(row)).toBe(row.version);
    }
    for (const userId of Object.keys(TOKEN_BY_USER)) {
      expect(await api.snapshotRow(userId)).toMatchObject({
        used: 80,
        version: 80,
      });
      expect(await api.redis.zCard(windowKey(userId))).toBe(80);
    }
  }, 15_000);
});
