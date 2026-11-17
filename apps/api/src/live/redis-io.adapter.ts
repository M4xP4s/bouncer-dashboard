import { type INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import {
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../redis/redis.module.js';

type AsyncCommand = (...args: unknown[]) => Promise<unknown>;
/** Members that return a promise, so state such as `isOpen` is refused. */
type CommandName = {
  [Name in keyof RedisClient]-?: RedisClient[Name] extends (
    ...args: never[]
  ) => Promise<unknown>
    ? Name
    : never;
}[keyof RedisClient];
type SubscribeName = Extract<CommandName, 'subscribe' | 'pSubscribe'>;
type AdapterFactory = ReturnType<typeof createAdapter>;

function wrapCommand(
  client: RedisClient,
  command: CommandName,
  wrap: (original: AsyncCommand) => AsyncCommand,
): void {
  // The commands take different arguments; the wrapper only forwards them.
  const original = (client[command] as AsyncCommand).bind(client);
  // Object.assign, because the client's type declares its commands read-only.
  Object.assign(client, { [command]: wrap(original) });
}

// The Socket.IO Redis adapter does not await these commands, so a rejection
// during an outage would be unhandled and end the process.
export function reportInsteadOfReject(
  client: RedisClient,
  commands: readonly CommandName[],
  onError: (error: unknown) => void,
): void {
  const report =
    (original: AsyncCommand): AsyncCommand =>
    (...args) =>
      original(...args).catch(onError);
  for (const command of commands) wrapCommand(client, command, report);
}

// A reconnect restores only the subscriptions Redis confirmed, so one that
// failed with its connection is sent again once the connection is back.
export function resubscribeWhenReady(
  client: RedisClient,
  commands: readonly SubscribeName[],
  onError: (error: unknown) => void,
): void {
  for (const command of commands) {
    wrapCommand(client, command, (original) => {
      const send: AsyncCommand = (...args) =>
        original(...args).catch((error: unknown) => {
          onError(error);
          client.once('ready', () => send(...args));
        });
      return send;
    });
  }
}

export class RedisIoAdapter extends IoAdapter {
  private constructor(
    app: INestApplicationContext,
    private readonly connections: RedisClient[],
    private readonly redisAdapter: AdapterFactory,
  ) {
    super(app);
  }

  // A subscribed connection sends no other command, and the publisher's
  // silenced failures must not touch the main client: two own connections.
  static async connect(
    app: INestApplicationContext,
    redisUrl: string,
  ): Promise<RedisIoAdapter> {
    const logger = new Logger(RedisIoAdapter.name);
    const publisher = await connectRedis(redisUrl, 'socket-publisher');
    const subscriber = await connectRedis(redisUrl, 'socket-subscriber').catch(
      async (error: unknown) => {
        // No adapter owns the publisher yet, so a failed start-up closes it.
        await closeRedis(publisher);
        throw error;
      },
    );
    reportInsteadOfReject(publisher, ['publish'], (error) =>
      logger.error('event not relayed to other processes', error),
    );
    // Called when a namespace is created and when the server closes.
    const reportSubscription = (error: unknown) =>
      logger.error('subscription not changed', error);
    resubscribeWhenReady(
      subscriber,
      ['subscribe', 'pSubscribe'],
      reportSubscription,
    );
    reportInsteadOfReject(
      subscriber,
      ['unsubscribe', 'pUnsubscribe'],
      reportSubscription,
    );
    const redisAdapter = createAdapter(publisher, subscriber);
    return new RedisIoAdapter(app, [publisher, subscriber], redisAdapter);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options);
    server.adapter(this.redisAdapter);
    return server;
  }

  // Nest calls this on shutdown, after the Socket.IO server has closed.
  override async dispose(): Promise<void> {
    await Promise.all(this.connections.map(closeRedis));
    await super.dispose();
  }
}
