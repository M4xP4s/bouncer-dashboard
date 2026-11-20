import {
  type ArgumentMetadata,
  BadRequestException,
  Body,
  type CallHandler,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  type ValidationError,
} from 'class-validator';
import type {
  ActivePeriod,
  Analytics,
  ExtraBody,
  HistoryBucket,
  SetLimitBody,
  Status,
  SuspendBody,
  UpdateCause,
  UserDetail,
  UserRow,
  UsersPage,
  UsersQuery,
} from '@app/contracts';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { AdminTokenGuard } from '../auth/admin-token.guard.js';
import { USER_ID } from '../config/config.js';
import { LiveGateway } from '../live/live.gateway.js';
import { HOURS_PER_DAY, MINUTES_PER_HOUR } from '../rate-limit/keys.js';
import { RateLimitStore } from '../rate-limit/rate-limit.store.js';
import { UserRegistry } from '../users/user-registry.js';
import { UserReads } from './user-reads.js';

const MIN_ACTION_VALUE = 1;
const MAX_BASE_LIMIT = 10_000;
const MAX_SUSPENSION_MINUTES = HOURS_PER_DAY * MINUTES_PER_HOUR;
const MAX_EXTRA_REQUESTS = 10_000;
const FIRST_PAGE = 1;
const MIN_PAGE_SIZE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// Keeps the offset (page - 1) * pageSize an exact integer.
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE);
const MAX_SEARCH_LENGTH = 64;
const STATUS_FILTERS: (Status | 'any')[] = ['any', 'OK', 'Warning', 'Exceeded'];
const SORT_ORDERS: UsersQuery['sort'][] = ['id', 'closest'];
const ACTIVE_FILTERS: (ActivePeriod | 'any')[] = ['any', '5m', '1h', '24h'];
const DECIMAL_DIGITS = /^\d+$/;

class SetLimitParams implements SetLimitBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_BASE_LIMIT) limit: number;
}
class SuspendParams implements SuspendBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_SUSPENSION_MINUTES) minutes: number;
}
class ExtraParams implements ExtraBody {
  @IsInt() @Min(MIN_ACTION_VALUE) @Max(MAX_EXTRA_REQUESTS) amount: number;
}

// Number() would also read "1e1", "0x10" or " +5"; anything but plain digits
// stays a string, which @IsInt refuses.
const decimalNumber = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && DECIMAL_DIGITS.test(value)
    ? Number(value)
    : value;

// An absent field keeps its default. A repeated one arrives as an array,
// which no rule accepts.
class UsersQueryParams implements UsersQuery {
  @Transform(decimalNumber)
  @IsInt()
  @Min(FIRST_PAGE)
  @Max(MAX_PAGE)
  page = FIRST_PAGE;
  @Transform(decimalNumber)
  @IsInt()
  @Min(MIN_PAGE_SIZE)
  @Max(MAX_PAGE_SIZE)
  pageSize = DEFAULT_PAGE_SIZE;
  @IsString() @MaxLength(MAX_SEARCH_LENGTH) search = '';
  @IsIn(STATUS_FILTERS) status: UsersQuery['status'] = 'any';
  @IsIn(ACTIVE_FILTERS) active: UsersQuery['active'] = 'any';
  @IsIn(SORT_ORDERS) sort: UsersQuery['sort'] = 'id';
}

const allowedKeyByBody = new Map<unknown, string>([
  [SetLimitParams, 'limit'],
  [SuspendParams, 'minutes'],
  [ExtraParams, 'amount'],
]);

function hasUnexpectedBodyKey(value: unknown, allowedKey: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => key !== allowedKey);
}

function invalidInputException(errors: ValidationError[]): BadRequestException {
  const message = errors
    .flatMap((error) => Object.values(error.constraints ?? {}))
    .join('; ');
  return new BadRequestException(message || 'Invalid input.');
}

/** Reject unknown raw keys before Nest's transformation can remove them. */
class AdminValidationPipe extends ValidationPipe {
  override transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    const allowedKey = allowedKeyByBody.get(metadata.metatype);
    if (
      metadata.type === 'body' &&
      allowedKey !== undefined &&
      hasUnexpectedBodyKey(value, allowedKey)
    ) {
      throw new BadRequestException('Unknown body field.');
    }
    return super.transform(value, metadata);
  }
}

/**
 * Refuses a malformed or unknown user before a Redis key can be read or
 * written. Nest resolves parameter pipes concurrently but runs interceptors
 * before them, so an unknown user is 404 before the body's values are
 * validated.
 */
@Injectable()
export class RegisteredUserInterceptor implements NestInterceptor {
  constructor(private readonly registry: UserRegistry) {}
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const { userId } = context.switchToHttp().getRequest<Request>().params;
    // Express types a wildcard parameter as a list; `:userId` is one string.
    if (typeof userId !== 'string' || !USER_ID.test(userId)) {
      throw new BadRequestException('Malformed user ID.');
    }
    if (!(await this.registry.exists(userId))) {
      throw new NotFoundException('Unknown user.');
    }
    return next.handle();
  }
}

@Controller('admin')
@UseGuards(AdminTokenGuard)
@UsePipes(
  new AdminValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: invalidInputException,
  }),
)
export class AdminController {
  constructor(
    private readonly reads: UserReads,
    private readonly store: RateLimitStore,
    private readonly live: LiveGateway,
  ) {}

  @Get('users')
  users(@Query() query: UsersQueryParams): Promise<UsersPage> {
    return this.reads.page(query, Date.now());
  }

  @Get('analytics')
  getAnalytics(): Promise<Analytics> {
    return this.reads.analytics(Date.now());
  }

  @Get('users/:userId')
  @UseInterceptors(RegisteredUserInterceptor)
  detail(@Param('userId') userId: string): Promise<UserDetail> {
    return this.store.detail(userId, Date.now());
  }

  @Get('users/:userId/history')
  @UseInterceptors(RegisteredUserInterceptor)
  history(
    @Param('userId') userId: string,
    @Query('range') range: unknown,
  ): Promise<HistoryBucket[]> {
    if (range !== 'hour' && range !== 'day') {
      throw new BadRequestException('Range must be hour or day.');
    }
    return this.store.history(userId, range, Date.now());
  }

  @Post('users/:userId/reset')
  @UseInterceptors(RegisteredUserInterceptor)
  @HttpCode(HttpStatus.OK)
  async reset(@Param('userId') userId: string): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.reset(userId, now);
    return this.publishUpdate('reset', now, row);
  }

  @Put('users/:userId/limit')
  @UseInterceptors(RegisteredUserInterceptor)
  async limit(
    @Param('userId') userId: string,
    @Body() body: SetLimitParams,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.setLimit(userId, now, body.limit);
    return this.publishUpdate('limit', now, row);
  }

  @Post('users/:userId/suspension')
  @UseInterceptors(RegisteredUserInterceptor)
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('userId') userId: string,
    @Body() body: SuspendParams,
  ): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.suspend(userId, now, body.minutes);
    return this.publishUpdate('suspend', now, row);
  }

  @Delete('users/:userId/suspension')
  @UseInterceptors(RegisteredUserInterceptor)
  async unsuspend(@Param('userId') userId: string): Promise<UserRow> {
    const now = Date.now();
    const row = await this.store.unsuspend(userId, now);
    return this.publishUpdate('unsuspend', now, row);
  }

  @Post('users/:userId/extra')
  @UseInterceptors(RegisteredUserInterceptor)
  @HttpCode(HttpStatus.OK)
  async extra(
    @Param('userId') userId: string,
    @Body() body: ExtraParams,
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
