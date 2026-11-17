import {
  Controller,
  Get,
  InternalServerErrorException,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { SampleResponse } from '@app/contracts';
import {
  type AuthenticatedRequest,
  UserTokenGuard,
} from '../auth/user-token.guard.js';
import { RateLimitInterceptor } from '../rate-limit/rate-limit.interceptor.js';

/**
 * The rate-limited demo route: stands in for any endpoint a user calls.
 *
 * The guard runs first and identifies the user; the interceptor then counts
 * the request against that user's quota. Admin and dashboard routes carry
 * neither, so watching the dashboard never uses anyone's quota.
 */
@Controller('sample')
@UseGuards(UserTokenGuard)
@UseInterceptors(RateLimitInterceptor)
export class SampleController {
  @Get('fail')
  fail(): never {
    throw new InternalServerErrorException('Sample failure.');
  }

  @Get()
  sample(@Req() request: AuthenticatedRequest): SampleResponse {
    return { ok: true, userId: request.userId, at: new Date().toISOString() };
  }
}
