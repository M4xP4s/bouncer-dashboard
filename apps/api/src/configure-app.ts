import type { INestApplication } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { RedisIoAdapter } from './live/redis-io.adapter.js';

export const API_PREFIX = 'api';

export async function configureApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix(API_PREFIX);
  const { redisUrl } = app.get<AppConfig>(APP_CONFIG);
  app.useWebSocketAdapter(await RedisIoAdapter.connect(app, redisUrl));
}
