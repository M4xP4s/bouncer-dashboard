import type { RateUpdateEvent } from '@app/contracts';
import { loadConfig } from '../src/config/config.js';
import { reportInsteadOfReject } from '../src/live/redis-io.adapter.js';
import {
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../src/redis/redis.module.js';
import {
  observeDashboard,
  requestUpdatesOf,
  SECOND_MS,
  TestApplication,
  useRelayedApplication,
} from './support/application.js';
import { relayToRedis, throughRelay } from './support/relay.js';

const CHANNEL = 'cross-process-test';
const RECOVERY_WAIT_MS = 8 * SECOND_MS;
const RECOVERY_POLL_MS = 250;

const target = new URL(loadConfig(process.env).redisUrl);

describe('events between two applications on one Redis', () => {
  let first: TestApplication | undefined;
  let second: TestApplication | undefined;
  const started = () => {
    if (!first || !second) throw new Error('The applications did not start');
    return { first, second };
  };

  beforeAll(async () => {
    first = await TestApplication.start();
    second = await TestApplication.start();
    await first.redis.flushDb();
    await first.registerDemoUsers();
  });

  afterAll(async () => {
    try {
      await first?.redis.flushDb();
    } finally {
      try {
        await second?.close();
      } finally {
        await first?.close();
      }
    }
  });

  it('a request to one reaches a dashboard connected to the other', async () => {
    const { first, second } = started();
    const socket = await first.dashboard();
    const received = new Promise<RateUpdateEvent>((resolve) =>
      socket.once('rate:update', resolve),
    );

    await second.sample('test-token-01').expect(200);

    expect(await received).toMatchObject({
      cause: 'request',
      row: { userId: 'user-01', used: 1, remaining: 99 },
    });
  });

  it('a server on the Redis adapter refuses a dashboard with a wrong token', async () => {
    await expect(started().first.dashboard('wrong-token')).rejects.toThrow(
      'Unauthorized',
    );
  });
});

describe('a dashboard whose application loses Redis and gets it back', () => {
  const relay = relayToRedis(target);
  const relayed = useRelayedApplication(relay, target);
  let other: TestApplication | undefined;
  const otherStarted = () => {
    if (!other) throw new Error('The other application did not start');
    return other;
  };

  beforeAll(async () => {
    other = await TestApplication.start();
  });

  afterAll(() => other?.close());

  it('receives the events of the other application, without a restart', async () => {
    const api = relayed();
    const otherApi = otherStarted();
    const socket = await api.dashboard();
    const { updates } = observeDashboard(socket);

    await relay.stop();
    await api.sample().expect(503);
    await relay.start();

    // An event published before the subscriber is back is lost, so the
    // request is repeated until one arrives.
    await vi.waitFor(
      async () => {
        await otherApi.sample('test-token-02').expect(200);
        expect(requestUpdatesOf(updates, 'user-02')).not.toHaveLength(0);
      },
      { timeout: RECOVERY_WAIT_MS, interval: RECOVERY_POLL_MS },
    );
  }, 20_000);
});

describe('the adapter connections through a Redis outage', () => {
  const relay = relayToRedis(target);
  let client: RedisClient | undefined;
  const connected = () => {
    if (!client) throw new Error('The client did not connect');
    return client;
  };

  beforeEach(async () => {
    const port = await relay.start();
    client = await connectRedis(
      throughRelay(target, port),
      'cross-process-test',
    );
  });

  afterEach(async () => {
    client?.destroy();
    client = undefined;
    await relay.stop();
  });

  it('with Redis stopped, a publish on a real client is reported, not rejected', async () => {
    const client = connected();
    await relay.stop();
    const onError = vi.fn();

    reportInsteadOfReject(client, ['publish'], onError);

    await expect(client.publish(CHANNEL, 'lost')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('a subscription survives a hang under traffic and the reconnect after it', async () => {
    const client = connected();
    const received = vi.fn();
    await client.subscribe(CHANNEL, received);
    relay.freeze();

    // Commands keep arriving, so it is the watchdog that drops the connection.
    // They fail with it, as the awaited ping below asserts; nothing to report.
    const traffic = setInterval(() => {
      client.ping().catch(() => {});
    }, 250);
    try {
      await expect(client.ping()).rejects.toThrow();
    } finally {
      clearInterval(traffic);
    }
    relay.thaw();
    await vi.waitFor(() => client.ping(), { timeout: 5_000, interval: 100 });

    // Published straight to Redis, as another API process would.
    const otherProcess = await connectRedis(target.href, 'other-process');
    try {
      await otherProcess.publish(CHANNEL, 'after the outage');
      await vi.waitFor(() =>
        expect(received).toHaveBeenCalledWith('after the outage', CHANNEL),
      );
    } finally {
      await closeRedis(otherProcess);
    }
  }, 15_000);
});
