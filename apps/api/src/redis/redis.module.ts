import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

/** Injection token for the connected Redis client. */
export const REDIS = Symbol('REDIS');

/** How long Redis may stay silent before the connection is closed. */
const SILENCE_LIMIT_MS = 3000;
const WATCHDOG_INTERVAL_MS = 1000;
const PING_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_DELAY_MS = 500;
/** How long a healthy connection may wait on shutdown for its replies. */
const SHUTDOWN_GRACE_MS = 1000;

function redisOptions(url: string, state: { connected: boolean }) {
  return {
    url,
    // One PING a second, so a healthy idle connection is never silent. Its
    // replies are what the watchdog counts as signs of life.
    pingInterval: PING_INTERVAL_MS,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Covers a silent peer only while nothing is written: every command
      // sent restarts this timer. The watchdog covers a hang under traffic.
      socketTimeout: SILENCE_LIMIT_MS,
      // Fail until the first connection succeeds, so the API refuses to
      // start without Redis; afterwards retry every half second.
      reconnectStrategy: (_retries: number, cause: Error) =>
        state.connected ? RECONNECT_DELAY_MS : cause,
    },
  };
}

/** Creates a client with the options above, not yet connected. */
function createRedisClient(url: string, state: { connected: boolean }) {
  return createClient(redisOptions(url, state));
}

/** The client type depends on its options, so it is taken from the factory. */
export type RedisClient = ReturnType<typeof createRedisClient>;

/**
 * A refused connection is an AggregateError with no message, only a code, and
 * a failed first connection wraps it.
 */
function describe(error: unknown): string {
  const { originalError = error } = error as { originalError?: unknown };
  const { message, code, name } = originalError as NodeJS.ErrnoException;
  return message || code || name;
}

/**
 * Logs a connection going down and coming back, once per change. The client
 * emits an `error` for every failed reconnect, and one with no listener would
 * end the process.
 */
function supervise(client: RedisClient, name: string): void {
  const logger = new Logger(`Redis:${name}`);
  let down = false;
  const markDown = (reason: string) => {
    if (down) return;
    down = true;
    logger.error(`connection down: ${reason}`);
  };

  client.on('error', (error: Error) => {
    // An error on a connection that is still up is not an outage.
    if (client.isReady) logger.error(describe(error));
    else markDown(describe(error));
  });
  client.on('ready', () => {
    if (!down) return;
    down = false;
    logger.log('connection restored');
  });
  watchForSilence(client, markDown);
}

/**
 * Destroys and reopens a connection whose PINGs have gone unanswered for
 * `SILENCE_LIMIT_MS`, which fails every command still waiting on it.
 */
function watchForSilence(
  client: RedisClient,
  markDown: (reason: string) => void,
): void {
  // A monotonic clock, so a change of the system time is not taken for silence.
  let lastReplyAt = performance.now();
  const noteReply = () => {
    lastReplyAt = performance.now();
  };
  client.on('ready', noteReply);
  client.on('ping-interval', noteReply);

  // The watchdog owns its timer and these two listeners: it alone removes them.
  const stop = () => {
    clearInterval(watchdog);
    client.off('ready', noteReply);
    client.off('ping-interval', noteReply);
  };

  const watchdog = setInterval(() => {
    // Closed for good, by shutdown or by a failed first connection.
    if (!client.isOpen) return stop();
    if (!client.isReady) return;
    if (performance.now() - lastReplyAt < SILENCE_LIMIT_MS) return;
    markDown(`no reply for ${SILENCE_LIMIT_MS} ms`);
    client.destroy();
    // Rejects only if the client is closed while reconnecting; failed
    // attempts are logged by the `error` listener.
    client.connect().catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
  // The watchdog alone must not keep the process alive.
  watchdog.unref();
}

/** Creates a client and connects it, or throws if the first attempt fails. */
export async function connectRedis(
  url: string,
  name = 'main',
): Promise<RedisClient> {
  const state = { connected: false };
  try {
    const client = createRedisClient(url, state);
    supervise(client, name);
    await client.connect();
    state.connected = true;
    return client;
  } catch (cause) {
    // Only the host: the URL may carry a password.
    throw new Error(
      `Cannot connect to Redis at ${new URL(url).host} (${describe(cause)}). ` +
        'If it is not running, start it with "docker compose up redis".',
      { cause },
    );
  }
}

/**
 * Closes a connection on shutdown. A healthy one gets a second to receive the
 * replies it is owed; then it is dropped whatever its state, so shutdown never
 * waits on a Redis that has stopped answering.
 */
export async function closeRedis(client: RedisClient): Promise<void> {
  if (client.isReady) {
    await Promise.race([
      client.close(),
      delay(SHUTDOWN_GRACE_MS, undefined, { ref: false }),
    ]);
  }
  client.destroy();
}

/** Provides the Redis client; the API does not listen until it has connected. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => connectRedis(config.redisUrl),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly client: RedisClient) {}

  /** Without this the open socket keeps the process alive. */
  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client);
  }
}
