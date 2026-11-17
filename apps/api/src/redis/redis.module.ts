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

/** Injection token for the one connected Redis client. */
export const REDIS = Symbol('REDIS');

/**
 * Client options, chosen with `supervise` below so that no command can wait
 * without a bound. Each was tried against a Redis that was stopped and one
 * that was paused (accepting connections but not answering); the defaults
 * leave a `MULTI` waiting indefinitely in both cases.
 */
function redisOptions(url: string, state: { connected: boolean }) {
  return {
    url,
    socket: {
      connectTimeout: 1000,
      // Before the first successful connection, fail: the process should
      // refuse to start without Redis rather than hang. Afterwards, retry
      // every half second for as long as it takes, including after a socket
      // timeout, which the default strategy treats as final.
      reconnectStrategy: (_retries: number, cause: Error) =>
        state.connected ? 500 : cause,
    },
  };
}

/** Creates a client with the options above, not yet connected. */
function createRedisClient(url: string, state: { connected: boolean }) {
  return createClient(redisOptions(url, state));
}

/**
 * The client type every consumer and every mock uses. Taken from the call
 * above because the client's type depends on the options it was created
 * with.
 */
export type RedisClient = ReturnType<typeof createRedisClient>;

/** A refused connection arrives as an AggregateError with no message. */
function describe(error: unknown): string {
  const { message, code, name } = error as NodeJS.ErrnoException;
  return message || code || name;
}

/**
 * Watches one connection: logs it going down and coming back, once per
 * change, and drops it when Redis has stopped answering.
 *
 * The log is needed because the client emits an error for every failed
 * reconnect attempt (two a second), and an `error` event with no listener
 * would end the process.
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
    // An error on a connection that is still up (an error reply to the
    // interval ping, for example) is reported but is not an outage.
    if (client.isReady) logger.error(describe(error));
    else markDown(describe(error));
  });
  client.on('ready', () => {
    if (!down) return;
    down = false;
    logger.log('connection restored');
  });
}

/**
 * Creates one supervised client and connects it, or throws if that fails.
 * Every connection is made here, each with its own reconnect state, so each
 * one fails fast at startup and retries only after it has once connected.
 */
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
 * Closes a connection on shutdown. A healthy connection is given a second
 * to receive the replies it is still owed, because dropping it at once
 * rejects those commands. Then it is dropped whatever its state, so shutdown
 * never waits on a Redis that is absent or has just stopped answering.
 */
export async function closeRedis(client: RedisClient): Promise<void> {
  if (client.isReady) {
    await Promise.race([
      client.close(),
      delay(1000, undefined, { ref: false }),
    ]);
  }
  client.destroy();
}

/**
 * Provides the one Redis client. Connecting is part of building the
 * application, so the API does not listen until Redis has answered.
 */
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

  /** Without this the open socket keeps the process alive after shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client);
  }
}
