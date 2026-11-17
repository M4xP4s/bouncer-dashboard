import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { bearerToken } from './token.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

/** A request that passed `UserTokenGuard`. */
export interface AuthenticatedRequest extends Request {
  /** Set by the guard from the caller's credential, never by the caller. */
  userId: string;
}

/**
 * Demo authentication: maps `Authorization: Bearer <token>` to a seeded user.
 * The user ID comes only from this lookup, never from the client, so one user
 * cannot spend another's quota. A real system would get it from an identity
 * provider.
 */
@Injectable()
export class UserTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization) ?? '';
    const userId = this.config.userIdByToken.get(token);
    if (userId === undefined) {
      // One message for every failure: do not tell the caller which part was wrong.
      throw new UnauthorizedException('A valid user token is required.');
    }
    request.userId = userId;
    return true;
  }
}
