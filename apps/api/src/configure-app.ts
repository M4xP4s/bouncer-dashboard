import type { INestApplication } from '@nestjs/common';

export async function configureApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix('api');
}
