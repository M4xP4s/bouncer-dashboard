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
 * Demo authentication for user traffic: `Authorization: Bearer <token>`,
 * looked up in the seeded users.
 *
 * The user ID that rate limiting is keyed on comes only from this lookup.
 * The client never sends a user ID, so one user cannot spend another's
 * quota by naming them. In a real system an identity provider would supply
 * the ID; the seeded tokens stand in for it.
 */
@Injectable()
export class UserTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // The scheme is case-insensitive in HTTP; the token is everything after
    // it, so a header with anything more is not a token we issued.
    const token = bearerToken(request.headers.authorization);
    const userId = token ? this.config.userIdByToken.get(token) : undefined;
    if (userId === undefined) {
      // One message for every case: which part was wrong is not the
      // caller's business.
      throw new UnauthorizedException('A valid user token is required.');
    }
    request.userId = userId;
    return true;
  }
}
