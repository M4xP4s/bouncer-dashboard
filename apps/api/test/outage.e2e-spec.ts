import type { Response } from 'supertest';
import { loadConfig } from '../src/config/config.js';
import {
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../src/redis/redis.module.js';
import { SECOND_MS, TestApplication } from './support/application.js';
import { Relay } from './support/relay.js';

const REDIS_DEFAULT_PORT = 6379;
// Platform rule 7 notices a silent Redis within about 4 s.
const FIRST_FAILURE_LIMIT_MS = 5 * SECOND_MS;
// Once the outage is known, a call must fail at once, not wait again.
const LATER_FAILURE_LIMIT_MS = SECOND_MS / 2;
const LATER_ROUNDS = 3;
const TRAFFIC_INTERVAL_MS = 200;
const RECOVERY_WAIT_MS = 8 * SECOND_MS;
const RECOVERY_POLL_MS = 100;

const OUTAGES = [
  ['stopped', (relay: Relay) => relay.stop(), (relay: Relay) => relay.start()],
  ['hung', (relay: Relay) => relay.freeze(), (relay: Relay) => relay.thaw()],
] as const;

function throughRelay(target: URL, port: number): string {
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.href;
}

/**
 * Starts the application on a relay in front of the test Redis for each test
 * and empties the database around it.
 */
function useRelayedApplication(relay: Relay, target: URL) {
  let api: TestApplication | undefined;
  let inspector: RedisClient | undefined;
  beforeEach(async () => {
    // Connected directly, so it can empty the database whatever the relay does.
    inspector = await connectRedis(target.href, 'outage-test-inspector');
    await inspector.flushDb();
    vi.stubEnv('REDIS_URL', throughRelay(target, await relay.start()));
    api = await TestApplication.start();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const connected = inspector;
    inspector = undefined;
    try {
      await api?.close();
    } finally {
      api = undefined;
      await relay.stop();
      // Unset when set-up failed before it connected; that error is reported.
      if (connected)
        await connected.flushDb().finally(() => closeRedis(connected));
    }
  });
  return () => {
    if (!api) throw new Error('The application did not start');
    return api;
  };
}

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
  const relay = new Relay(
    target.hostname,
    Number(target.port || REDIS_DEFAULT_PORT),
  );
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
