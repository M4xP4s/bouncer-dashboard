import request from 'supertest';
import { loadConfig } from '../src/config/config.js';
import {
  FIRST_FAILURE_LIMIT_MS,
  LATER_FAILURE_LIMIT_MS,
  REQUEST_DEADLINE_MS,
  SECOND_MS,
  useRelayedApplication,
} from './support/application.js';
import { relayToRedis } from './support/relay.js';

const LATER_ROUNDS = 3;
const RECOVERY_WAIT_MS = 8 * SECOND_MS;
const RECOVERY_POLL_MS = 100;
const UNAVAILABLE = {
  statusCode: 503,
  error: 'Service Unavailable',
  message: 'Redis is not reachable.',
};

describe('GET /api/health against Redis (real clock)', () => {
  const target = new URL(loadConfig(process.env).redisUrl);
  const relay = relayToRedis(target);
  const application = useRelayedApplication(relay, target);

  // No credential is set: the route needs none.
  const health = () =>
    request(application().url)
      .get('/api/health')
      .timeout({ deadline: REQUEST_DEADLINE_MS });

  it('answers 200 while Redis answers', async () => {
    await health().expect(200, { status: 'ok' });
  });

  const expectUnavailableWithin = async (limitMs: number) => {
    const started = performance.now();
    await health().expect(503, UNAVAILABLE);
    expect(performance.now() - started).toBeLessThan(limitMs);
  };

  const expectRecovery = () =>
    vi.waitFor(() => health().expect(200), {
      timeout: RECOVERY_WAIT_MS,
      interval: RECOVERY_POLL_MS,
    });

  it('answers 503 while Redis is stopped, and 200 once it is back', async () => {
    await relay.stop();

    await health().expect(503, UNAVAILABLE);

    await relay.start();
    await expectRecovery();
  }, 15_000);

  it('answers 503 within the bound while Redis is hung, and 200 once it answers', async () => {
    relay.freeze();

    await expectUnavailableWithin(FIRST_FAILURE_LIMIT_MS);
    // By now the client is reconnecting to a server that does not answer.
    for (let round = 0; round < LATER_ROUNDS; round++)
      await expectUnavailableWithin(LATER_FAILURE_LIMIT_MS);

    relay.thaw();
    await expectRecovery();
  }, 20_000);
});
