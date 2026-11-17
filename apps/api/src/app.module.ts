import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AdminController, SeededUserPipe } from './admin/admin.controller.js';
import { AdminTokenGuard } from './auth/admin-token.guard.js';
import { ApiErrorFilter } from './api-error.filter.js';
import { UserTokenGuard } from './auth/user-token.guard.js';
import { ConfigModule } from './config/config.module.js';
import { LiveGateway } from './live/live.gateway.js';
import { RateLimitInterceptor } from './rate-limit/rate-limit.interceptor.js';
import { RateLimitStore } from './rate-limit/rate-limit.store.js';
import { RedisModule } from './redis/redis.module.js';
import { SampleController } from './sample/sample.controller.js';

@Module({
  imports: [ConfigModule, RedisModule],
  controllers: [SampleController, AdminController],
  providers: [
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    LiveGateway,
    UserTokenGuard,
    AdminTokenGuard,
    SeededUserPipe,
    RateLimitStore,
    RateLimitInterceptor,
  ],
})
export class AppModule {}
