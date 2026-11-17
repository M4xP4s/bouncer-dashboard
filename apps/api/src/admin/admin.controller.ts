import {
  type ArgumentMetadata,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  type PipeTransform,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import type {
  Analytics,
  HistoryBucket,
  UpdateCause,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { AdminTokenGuard } from '../auth/admin-token.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { LiveGateway } from '../live/live.gateway.js';
import { RateLimitStore } from '../rate-limit/rate-limit.store.js';
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

/** Admin reads and actions are guarded and never consume a user's quota. */
@Controller('admin')
@UseGuards(AdminTokenGuard)
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
  async getAnalytics(): Promise<Analytics> {
    const now = Date.now();
    const [rows, denied] = await Promise.all([
      this.store.snapshot([...this.config.userIds], now),
      this.store.denied429(now),
    ]);
    return analytics(rows, denied, now);
  }

  @Get('users/:userId')
  detail(@Param('userId', SeededUserPipe) userId: string): Promise<UserDetail> {
    return this.store.detail(userId, Date.now());
  }

  @Get('users/:userId/history')
  history(
    @Param('userId', SeededUserPipe) userId: string,
    @Query('range') range: unknown,
  ): Promise<HistoryBucket[]> {
    if (range !== 'hour' && range !== 'day')
      throw new BadRequestException('Range must be hour or day.');
    return this.store.history(userId, range, Date.now());
  }

  @Post('users/:userId/reset')
  @HttpCode(HttpStatus.OK)
  async reset(
    @Param('userId', SeededUserPipe) userId: string,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.reset(userId, now);
    return this.publishUpdate('reset', now, row);
  }

  @Put('users/:userId/limit')
  async limit(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: LimitBody,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.setLimit(userId, now, body.limit);
    return this.publishUpdate('limit', now, row);
  }

  @Post('users/:userId/suspension')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: SuspendBody,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.suspend(userId, now, body.minutes);
    return this.publishUpdate('suspend', now, row);
  }

  @Delete('users/:userId/suspension')
  async unsuspend(
    @Param('userId', SeededUserPipe) userId: string,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.unsuspend(userId, now);
    return this.publishUpdate('unsuspend', now, row);
  }

  @Post('users/:userId/extra')
  @HttpCode(HttpStatus.OK)
  async extra(
    @Param('userId', SeededUserPipe) userId: string,
    @Body() body: ExtraBody,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.addExtra(userId, now, body.amount);
    return this.publishUpdate('extra', now, row);
  }

  private publishUpdate(
    cause: UpdateCause,
    now: number,
    row: UserRow,
  ): UserRow {
    this.live.emitUpdate({
      cause,
      at: new Date(now).toISOString(),
      row,
      request: null,
    });
    return row;
  }
}
