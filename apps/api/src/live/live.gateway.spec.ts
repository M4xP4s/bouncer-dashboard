import { Logger } from '@nestjs/common';
import type { RateLimitExceededEvent, RateUpdateEvent } from '@app/contracts';
import type { Server, Socket } from 'socket.io';
import { mockDeep } from 'vitest-mock-extended';
import { loadConfig } from '../config/config.js';
import { LiveGateway } from './live.gateway.js';
import { buildRow } from '../rate-limit/row.js';

const config = loadConfig({
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_TOKEN: 'admin-token',
  DEMO_USERS: 'user-01:token-01',
});

function gatewayWithServer() {
  const server = mockDeep<Server>();
  const gateway = new LiveGateway(config);
  gateway.server = server;
  gateway.afterInit(server);
  return { gateway, server };
}

/** Runs the handshake check the gateway registered, as Socket.IO would. */
function handshake(auth: unknown): Error | undefined {
  const { server } = gatewayWithServer();
  const check = server.use.mock.calls[0][0];
  const next = vi.fn();
  check({ handshake: { auth } } as Socket, next);
  return next.mock.calls[0][0];
}

describe('LiveGateway handshake', () => {
  it('accepts the admin token', () => {
    expect(handshake({ token: 'admin-token' })).toBeUndefined();
  });

  it.each([
    ['a wrong token', { token: 'admin-tokem' }],
    ['a token of another length', { token: 'admin' }],
    ['a user token', { token: 'token-01' }],
    ['no token', {}],
    ['a token that is not a string', { token: ['admin-token'] }],
  ])('refuses %s', (_case, auth) => {
    expect(handshake(auth)).toBeInstanceOf(Error);
  });
});

describe('LiveGateway.emitUpdate', () => {
  const event = { cause: 'request', at: 'now' } as RateUpdateEvent;

  it('sends rate:update to every connected dashboard', () => {
    const { gateway, server } = gatewayWithServer();

    gateway.emitUpdate(event);

    expect(server.emit).toHaveBeenCalledExactlyOnceWith('rate:update', event);
  });

  it('logs a failed emit and does not throw', () => {
    // The request that caused the event has already been decided; a
    // dashboard that misses it is repaired by its next snapshot.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { gateway, server } = gatewayWithServer();
    server.emit.mockImplementation(() => {
      throw new Error('cannot encode');
    });

    expect(() => gateway.emitUpdate(event)).not.toThrow();
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('LiveGateway.emitLimitExceeded', () => {
  const at = '2026-11-16T10:42:00.000Z';
  const row = buildRow('user-01', [100, null, null, null, {}], Date.parse(at));
  const event: RateLimitExceededEvent = {
    at,
    row,
    retryAt: row.resetAt,
    request: { id: 'request-1', at, outcome: 'denied', remaining: 0 },
  };

  afterEach(() => vi.restoreAllMocks());

  it('sends rate:limit_exceeded to every connected dashboard', () => {
    const { gateway, server } = gatewayWithServer();

    gateway.emitLimitExceeded(event);

    expect(server.emit).toHaveBeenCalledExactlyOnceWith(
      'rate:limit_exceeded',
      event,
    );
  });

  it('logs a failed emit with its cause and does not throw', () => {
    const cause = new Error('cannot encode');
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { gateway, server } = gatewayWithServer();
    server.emit.mockImplementation(() => {
      throw cause;
    });

    expect(() => gateway.emitLimitExceeded(event)).not.toThrow();
    expect(logged).toHaveBeenCalledWith(
      'rate:limit_exceeded was not sent',
      cause,
    );
  });
});
