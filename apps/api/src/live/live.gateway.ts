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

/**
 * The Socket.IO server the admin dashboard connects to: same port as HTTP,
 * default path and namespace. Every connected dashboard receives every
 * event; the server listens for nothing.
 */
@WebSocketGateway()
export class LiveGateway implements OnGatewayInit {
  private readonly logger = new Logger(LiveGateway.name);

  /** Typed with the shared event map, so an emit must match the contract. */
  @WebSocketServer()
  server: Server<ClientToServerEvents, ServerToClientEvents>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Refuses a connection that does not present the admin token (demo
   * authentication, like the HTTP admin routes). Events carry every user's
   * usage, so the check runs in the handshake, before the socket can
   * receive anything.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      const { token } = socket.handshake.auth as Partial<SocketAuth>;
      const allowed =
        typeof token === 'string' && sameToken(token, this.config.adminToken);
      next(allowed ? undefined : new Error('Unauthorized'));
    });
  }

  /**
   * Sends `rate:update` from this process; the Redis adapter carries it to
   * dashboards connected to other API processes.
   *
   * Never throws. The request or admin action that caused the event has
   * already been decided and must not fail because a dashboard could not be
   * told; the dashboard's next snapshot repairs what it missed.
   */
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
