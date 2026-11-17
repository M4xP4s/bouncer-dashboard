import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiErrorFilter } from './api-error.filter.js';
import { UserTokenGuard } from './auth/user-token.guard.js';
import { ConfigModule } from './config/config.module.js';
import { RateLimitStore } from './rate-limit/rate-limit.store.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    UserTokenGuard,
    RateLimitStore,
  ],
})
export class AppModule {}
