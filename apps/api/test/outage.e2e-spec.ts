import type { Response } from 'supertest';
import { loadConfig } from '../src/config/config.js';
import {
  FIRST_FAILURE_LIMIT_MS,
  LATER_FAILURE_LIMIT_MS,
  SECOND_MS,
  type TestApplication,
  useRelayedApplication,
} from './support/application.js';
import { type Relay, relayToRedis } from './support/relay.js';

const LATER_ROUNDS = 3;
const TRAFFIC_INTERVAL_MS = 200;
const RECOVERY_WAIT_MS = 8 * SECOND_MS;
const RECOVERY_POLL_MS = 100;

const OUTAGES = [
  ['stopped', (relay: Relay) => relay.stop(), (relay: Relay) => relay.start()],
  ['hung', (relay: Relay) => relay.freeze(), (relay: Relay) => relay.thaw()],
] as const;

async function timed(call: PromiseLike<Response>) {
  const started = performance.now();
  const response = await call;
  return { response, ms: performance.now() - started };
}

/** A sample request and an admin action, sent together and timed. */
const sampleAndAdmin = (api: TestApplication) =>
  Promise.all([
    timed(api.sample()),
    timed(api.admin('post', '/users/user-02/reset')),
  ]);

const ignore = () => {};

/** Runs `step` while a sample request arrives every 200 ms. */
async function underTraffic<T>(api: TestApplication, step: () => Promise<T>) {
  const background: Promise<void>[] = [];
  // Every write restarts the socket timeout, so only the watchdog can notice.
  const traffic = setInterval(() => {
    background.push(api.sample().then(ignore, ignore));
  }, TRAFFIC_INTERVAL_MS);
  try {
    return await step();
  } finally {
    clearInterval(traffic);
    await Promise.all(background);
  }
}

function expectUnavailableWithin(
  results: Awaited<ReturnType<typeof sampleAndAdmin>>,
  limitMs: number,
) {
  for (const { response, ms } of results) {
    expect(response.status).toBe(503);
    expect(ms).toBeLessThan(limitMs);
    expect(response.headers).not.toHaveProperty('x-count');
    expect(response.body).toMatchObject({
      statusCode: 503,
      error: expect.any(String),
      message: expect.any(String),
    });
  }
}

describe('HTTP through a Redis outage', () => {
  const target = new URL(loadConfig(process.env).redisUrl);
  const relay = relayToRedis(target);
  const application = useRelayedApplication(relay, target);

  it.each(OUTAGES)(
    'answers 503 within a bound while Redis is %s, then serves again without a restart',
    async (_outage, cut, restore) => {
      const api = application();
      await api.sample().expect(200);
      await api.sample('test-token-02').expect(200);

      await cut(relay);
      const rounds = await underTraffic(api, async () => {
        const results = [await sampleAndAdmin(api)];
        for (let round = 0; round < LATER_ROUNDS; round++)
          results.push(await sampleAndAdmin(api));
        return results;
      });

      const [first, ...later] = rounds;
      expectUnavailableWithin(first, FIRST_FAILURE_LIMIT_MS);
      for (const round of later)
        expectUnavailableWithin(round, LATER_FAILURE_LIMIT_MS);

      await restore(relay);
      // Poll with a read: the admin action may or may not have been applied.
      const recovered = async () => {
        await api.admin('get', '/users').expect(200);
      };
      await vi.waitFor(recovered, {
        timeout: RECOVERY_WAIT_MS,
        interval: RECOVERY_POLL_MS,
      });

      await api.sample().expect(200);
      // Resets sent during the outage may have applied; this one must clear
      // a request admitted after it.
      await api.sample('test-token-02').expect(200);
      await api.admin('post', '/users/user-02/reset').expect(200);
      expect((await api.detail('user-02')).row.used).toBe(0);
    },
    20_000,
  );
});
