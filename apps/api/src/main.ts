import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { configureApp } from './configure-app.js';

// Host-mode development keeps its settings in the repository's .env file.
// In a container there is no such file and Compose supplies the environment.
// Variables that are already set win over the file.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// An invalid environment or an unreachable Redis makes this throw; Nest logs
// the reason and exits, so the process never listens half-configured.
const app = await NestFactory.create(AppModule);
await configureApp(app);
// Close the HTTP server, the sockets and the Redis connections on SIGTERM,
// which is how `docker compose down` stops the container.
app.enableShutdownHooks();
await app.listen(app.get<AppConfig>(APP_CONFIG).port);
