import { ServiceUnavailableException } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import type { RedisClient } from '../redis/redis.module.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('answers ok when Redis answers PING', async () => {
    const redis = mockDeep<RedisClient>({ isReady: true });
    redis.ping.mockResolvedValue('PONG');

    await expect(new HealthController(redis).check()).resolves.toEqual({
      status: 'ok',
    });
  });

  it('answers 503 in the shared error shape when PING fails', async () => {
    const redis = mockDeep<RedisClient>({ isReady: true });
    const offline = new Error('The client is offline');
    redis.ping.mockRejectedValue(offline);

    const check = new HealthController(redis).check();
    const failure: unknown = await check.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    if (!(failure instanceof ServiceUnavailableException)) throw failure;
    expect(failure.getResponse()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Redis is not reachable.',
    });
    expect(failure.cause).toBe(offline);
  });

  it('answers 503 without sending PING while the connection is down', async () => {
    const redis = mockDeep<RedisClient>({ isReady: false });

    await expect(new HealthController(redis).check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis.ping).not.toHaveBeenCalled();
  });
});
