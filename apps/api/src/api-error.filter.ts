import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { ApiError } from '@app/contracts';
import { StoreUnavailable } from './rate-limit/rate-limit.store.js';

/** Keep middleware and route errors in one envelope without exposing defects. */
@Catch()
export class ApiErrorFilter extends BaseExceptionFilter<unknown> {
  private readonly logger = new Logger(ApiErrorFilter.name);

  override catch(error: unknown, host: ArgumentsHost): void {
    const { statusCode, payload } = this.describe(error);
    const body = typeof payload === 'string' ? { message: payload } : payload;
    const label = STATUS_CODES[statusCode] ?? 'Error';
    // Preserve fields such as retryAt; the base filter owns headers-sent handling.
    const envelope = {
      ...body,
      statusCode,
      error: errorNameOf(body, label),
      message: messageOf(body, label),
    };
    super.catch(new HttpException(envelope, statusCode), host);
  }

  /** The status and payload to send; a defect is logged, never exposed. */
  private describe(error: unknown): {
    statusCode: number;
    payload: string | object;
  } {
    if (error instanceof StoreUnavailable) {
      this.logger.error('Rate limit store did not answer', error.cause);
      // A lost reply leaves the outcome of a write uncertain.
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        payload: 'The rate limit store did not answer.',
      };
    }
    if (error instanceof HttpException) {
      return { statusCode: error.getStatus(), payload: error.getResponse() };
    }
    if (this.isHttpError(error)) {
      // Reuse Nest's middleware-error classification and message exposure rule.
      return {
        statusCode: error.statusCode,
        payload: this.getHttpErrorMessage(error),
      };
    }
    this.logger.error('Unexpected API error', error);
    return { statusCode: 500, payload: 'Internal server error' };
  }
}

export function serviceUnavailable(
  message: string,
  cause: unknown,
): ServiceUnavailableException {
  const body: ApiError = {
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    message,
  };
  return new ServiceUnavailableException(body, { cause });
}

function errorNameOf(body: object, fallback: string): string {
  return 'error' in body && typeof body.error === 'string'
    ? body.error
    : fallback;
}

/** Nest's validation errors carry a list of messages; send them as one. */
function messageOf(body: object, fallback: string): string {
  if (!('message' in body)) return fallback;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) return body.message.join('; ');
  return fallback;
}
