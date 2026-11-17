import type { INestApplication } from '@nestjs/common';

/**
 * Everything that is set on the application after it is created and before
 * it listens. `main.ts` and the integration tests both call this, so a test
 * exercises the same prefix and the same socket adapter as the real process.
 */
export async function configureApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix('api');
}
