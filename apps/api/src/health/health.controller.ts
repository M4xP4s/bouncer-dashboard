import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@app/contracts';
import { serviceUnavailable } from '../api-error.filter.js';
import { REDIS, type RedisClient } from '../redis/redis.module.js';

// No guard: a readiness check holds no credential, and the answer reveals
// nothing about any user.
@Controller('health')
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  // Every request needs Redis, so a process cut off from it is not healthy.
  @Get()
  async check(): Promise<HealthResponse> {
    // A PING sent while reconnecting would wait for the reconnect to settle.
    if (!this.redis.isReady) {
      throw serviceUnavailable(
        'Redis is not reachable.',
        new Error('The Redis connection is down.'),
      );
    }
    try {
      await this.redis.ping();
    } catch (error) {
      throw serviceUnavailable('Redis is not reachable.', error);
    }
    return { status: 'ok' };
  }
}
