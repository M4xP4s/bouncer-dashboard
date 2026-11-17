import {
  ArgumentsHost,
  type ArgumentMetadata,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  type PipeTransform,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import type { Response } from 'express';
import type { UpdateCause, UserRow } from '@app/contracts';
import { AdminTokenGuard } from '../auth/admin-token.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { LiveGateway } from '../live/live.gateway.js';
import {
  RateLimitStore,
  StoreUnavailable,
} from '../rate-limit/rate-limit.store.js';
import { analytics } from './analytics.js';

const MIN_ACTION_VALUE = 1;
const MAX_BASE_LIMIT = 10_000;
const MAX_SUSPENSION_MINUTES = 1440;
const MAX_EXTRA_REQUESTS = 10_000;

class LimitBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_BASE_LIMIT) limit: number;
}
class SuspendBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_SUSPENSION_MINUTES) minutes: number;
}
class ExtraBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_EXTRA_REQUESTS) amount: number;
}

const bodyFields = new Map<unknown, string>([
  [LimitBody, 'limit'],
  [SuspendBody, 'minutes'],
  [ExtraBody, 'amount'],
]);

/** Reject unknown raw keys before Nest's transformation can remove them. */
class AdminValidationPipe extends ValidationPipe {
  override transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    const field = bodyFields.get(metadata.metatype);
    if (
      metadata.type === 'body' &&
      field !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      Object.keys(value).some((key) => key !== field)
    ) {
      throw new BadRequestException('Unknown body field.');
    }
    return super.transform(value, metadata);
  }
}

/** Refuse unknown users before a Redis key can be read or written. */
@Injectable()
export class SeededUserPipe implements PipeTransform<string, string> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  transform(userId: string): string {
    if (!this.config.userIds.has(userId))
      throw new NotFoundException('Unknown user.');
    return userId;
  }
}

/** A timed-out write may have landed; do not promise that it did not. */
@Catch(StoreUnavailable)
export class StoreUnavailableFilter implements ExceptionFilter {
  private readonly logger = new Logger(StoreUnavailableFilter.name);
  catch(error: StoreUnavailable, host: ArgumentsHost): void {
    this.logger.error('Rate limit store did not answer', error.cause);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: 'The rate limit store did not answer.',
      });
  }
}

/** Admin reads and actions are guarded and never consume a user's quota. */
@Controller('admin')
@UseGuards(AdminTokenGuard)
@UseFilters(StoreUnavailableFilter)
@UsePipes(
  new AdminValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException(
        errors
          .flatMap((error) => Object.values(error.constraints ?? {}))
          .join('; ') || 'Invalid body.',
      ),
  }),
)
export class AdminController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: RateLimitStore,
    private readonly live: LiveGateway,
  ) {}

  @Get('users')
  users(): Promise<UserRow[]> {
    return this.store.snapshot([...this.config.userIds].sort(), Date.now());
  }

  @Get('analytics')
  async getAnalytics() {
    const now = Date.now();
    const [rows, denied] = await Promise.all([
      this.store.snapshot([...this.config.userIds], now),
      this.store.denied429(now),
    ]);
    return analytics(rows, denied, now);
  }

  @Get('users/:userId')
  detail(@Param('userId', SeededUserPipe) userId: string) {
    return this.store.detail(userId, Date.now());
  }

  @Get('users/:userId/history')
  history(
    @Param('userId', SeededUserPipe) userId: string,
    @Query('range') range: unknown,
  ) {
    if (range !== 'hour' && range !== 'day')
      throw new BadRequestException('Range must be hour or day.');
    return this.store.history(userId, range, Date.now());
  }

  @Post('users/:userId/reset')
  @HttpCode(HttpStatus.OK)
  reset(@Param('userId', SeededUserPipe) userId: string) {
    const now = Date.now();
    return this.action('reset', now, this.store.reset(userId, now));
  }
  @Put('users/:userId/limit')
  limit(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: LimitBody,
  ) {
    const now = Date.now();
    return this.action(
      'limit',
      now,
      this.store.setLimit(userId, now, body.limit),
    );
  }
  @Post('users/:userId/suspension')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: SuspendBody,
  ) {
    const now = Date.now();
    return this.action(
      'suspend',
      now,
      this.store.suspend(userId, now, body.minutes),
    );
  }
  @Delete('users/:userId/suspension')
  unsuspend(@Param('userId', SeededUserPipe) userId: string) {
    const now = Date.now();
    return this.action('unsuspend', now, this.store.unsuspend(userId, now));
  }
  @Post('users/:userId/extra')
  @HttpCode(HttpStatus.OK)
  extra(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: ExtraBody,
  ) {
    const now = Date.now();
    return this.action(
      'extra',
      now,
      this.store.addExtra(userId, now, body.amount),
    );
  }
  private async action(
    cause: UpdateCause,
    now: number,
    pending: Promise<UserRow>,
  ): Promise<UserRow> {
    const row = await pending;
    this.live.emitUpdate({
      cause,
      at: new Date(now).toISOString(),
      row,
      request: null,
    });
    return row;
  }
}
