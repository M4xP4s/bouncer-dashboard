import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { bearerToken, sameToken } from './token.js';

/** Admin HTTP access uses the same demo credential as the socket handshake. */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const token = bearerToken(
      context.switchToHttp().getRequest<Request>().headers.authorization,
    );
    if (!token || !sameToken(token, this.config.adminToken)) {
      throw new UnauthorizedException('A valid admin token is required.');
    }
    return true;
  }
}
