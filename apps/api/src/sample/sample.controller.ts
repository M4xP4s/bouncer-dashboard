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

// Authenticate first, then charge both sample routes against the same user quota.
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
