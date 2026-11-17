import { Inject, Logger } from '@nestjs/common';
import {
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type {
  ClientToServerEvents,
  RateLimitExceededEvent,
  RateUpdateEvent,
  ServerToClientEvents,
  SocketAuth,
} from '@app/contracts';
import type { Server } from 'socket.io';
import { sameToken } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

// Every authenticated dashboard on this process receives every event.
@WebSocketGateway()
export class LiveGateway implements OnGatewayInit {
  private readonly logger = new Logger(LiveGateway.name);

  /** Typed with the shared event map, so an emit must match the contract. */
  @WebSocketServer()
  server: Server<ClientToServerEvents, ServerToClientEvents>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  // Events expose all users’ usage, so authenticate before the socket receives any.
  afterInit(server: Server): void {
    server.use((socket, next) => {
      const { token } = socket.handshake.auth as Partial<SocketAuth>;
      const allowed =
        typeof token === 'string' && sameToken(token, this.config.adminToken);
      next(allowed ? undefined : new Error('Unauthorized'));
    });
  }

  // Delivery failure must not change an already committed quota decision.
  emitUpdate(event: RateUpdateEvent): void {
    try {
      this.server.emit('rate:update', event);
    } catch (error) {
      this.logger.error('rate:update was not sent', error);
    }
  }

  /** Same best-effort delivery as updates; a missed alert cannot fail a request. */
  emitLimitExceeded(event: RateLimitExceededEvent): void {
    try {
      this.server.emit('rate:limit_exceeded', event);
    } catch (error) {
      this.logger.error('rate:limit_exceeded was not sent', error);
    }
  }
}
