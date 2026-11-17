import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './config.js';

/**
 * Provides the validated configuration to every module.
 *
 * The factory runs while Nest builds the application, so an invalid
 * environment fails `NestFactory.create` and the process never listens.
 */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig(process.env) },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
