import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { bearerToken } from './token.js';
import { UserRegistry } from '../users/user-registry.js';

export const USER_TOKEN_REQUIRED = 'A valid user token is required.';

/** A request that passed `UserTokenGuard`. */
export interface AuthenticatedRequest extends Request {
  /** Set by the guard from the caller's credential, never by the caller. */
  userId: string;
}

/**
 * Demo authentication: maps `Authorization: Bearer <token>` to a registered
 * user. The user ID comes only from this lookup, never from the client, so
 * one user cannot spend another's quota. A real system would get it from an
 * identity provider.
 */
@Injectable()
export class UserTokenGuard implements CanActivate {
  constructor(private readonly registry: UserRegistry) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    const userId = token ? await this.registry.identify(token) : null;
    if (userId === null) {
      // One message for every failure: do not tell the caller which part was wrong.
      throw new UnauthorizedException(USER_TOKEN_REQUIRED);
    }
    request.userId = userId;
    return true;
  }
}
