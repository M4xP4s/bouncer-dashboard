import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type NestInterceptor,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ApiError, RateLimitedError, RequestRecord } from '@app/contracts';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import {
  type AuthenticatedRequest,
  USER_TOKEN_REQUIRED,
} from '../auth/user-token.guard.js';
import { LiveGateway } from '../live/live.gateway.js';
import { retryAfterSeconds } from './keys.js';
import {
  type Admission,
  RateLimitStore,
  StoreUnavailable,
} from './rate-limit.store.js';

const COUNT_HEADER = 'x-count';

// Runs after UserTokenGuard; translates the store’s decision into HTTP.
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RateLimitInterceptor.name);

  constructor(
    private readonly store: RateLimitStore,
    private readonly live: LiveGateway,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const { userId } = http.getRequest<AuthenticatedRequest>();
    // Misapplying this interceptor without its guard must never create a shared bucket.
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException(USER_TOKEN_REQUIRED);
    }
    const response = http.getResponse<Response>();
    // The clock is read once. This one value selects the window, stamps the
    // request and decides whether a suspension is still active, so the
    // three can never disagree about which hour it is.
    const now = Date.now();
    const at = new Date(now).toISOString();

    const admission = await this.admit(userId, now);
    const { outcome, row, requestId } = admission;
    const firstRejection = await this.recordOutcome(userId, now, admission);
    const request: RequestRecord = {
      id: requestId,
      at,
      outcome,
      remaining: row.remaining,
    };

    if (outcome === 'denied') {
      if (firstRejection) {
        this.live.emitLimitExceeded({ at, row, retryAt: row.resetAt, request });
      }
      const seconds = retryAfterSeconds(now);
      response.setHeader('Retry-After', `${seconds}`);
      response.setHeader(COUNT_HEADER, '0');
      const body: RateLimitedError = {
        statusCode: 429,
        error: 'Too Many Requests',
        message:
          `Rate limit of ${row.total} requests per hour exceeded. ` +
          `Try again at ${row.resetAt.slice(11, 19)} UTC.`,
        retryAt: row.resetAt,
        retryAfterSeconds: seconds,
      };
      throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
    }

    // The remaining quota of the admission that just happened, taken from
    // the row that admission produced. It is never computed a second time.
    response.setHeader(COUNT_HEADER, `${row.remaining}`);
    this.live.emitUpdate({ cause: 'request', at, row, request });

    // From here the request is counted, whatever the handler does. There is
    // no refund path: a handler that fails has still used the quota.
    return next.handle();
  }

  private async admit(userId: string, now: number): Promise<Admission> {
    try {
      return await this.store.admit(userId, now);
    } catch (error) {
      // Error replies and defects propagate to the generic 500 handler.
      if (!(error instanceof StoreUnavailable)) throw error;
      this.logger.error('admission failed', error.cause);
      // The transaction may or may not have run, so the message makes no
      // claim about the quota.
      const body: ApiError = {
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The request was not processed. It may be retried.',
      };
      throw new ServiceUnavailableException(body, { cause: error });
    }
  }

  /**
   * Unavailable bookkeeping preserves admission or 429; error replies and
   * defects propagate before the handler, headers or events.
   */
  private async recordOutcome(
    userId: string,
    now: number,
    admission: Admission,
  ): Promise<boolean> {
    try {
      return await this.store.recordOutcome(userId, now, admission);
    } catch (error) {
      if (!(error instanceof StoreUnavailable)) {
        throw error;
      }
      this.logger.error('request bookkeeping failed', error.cause);
      return false;
    }
  }
}
