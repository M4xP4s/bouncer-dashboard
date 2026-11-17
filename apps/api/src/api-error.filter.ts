import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/** Keep middleware and route errors in one envelope without exposing defects. */
@Catch()
export class ApiErrorFilter extends BaseExceptionFilter<unknown> {
  private readonly logger = new Logger(ApiErrorFilter.name);

  override catch(error: unknown, host: ArgumentsHost): void {
    let statusCode = 500;
    let payload: string | object = 'Internal server error';
    if (error instanceof HttpException) {
      statusCode = error.getStatus();
      payload = error.getResponse();
    } else if (this.isHttpError(error)) {
      // Reuse Nest's middleware-error classification and message exposure rule.
      statusCode = error.statusCode;
      payload = this.getHttpErrorMessage(error);
    } else {
      this.logger.error('Unexpected API error', error);
    }

    const body = typeof payload === 'string' ? { message: payload } : payload;
    const label = STATUS_CODES[statusCode] ?? 'Error';
    let message = label;
    if ('message' in body) {
      if (typeof body.message === 'string') message = body.message;
      else if (Array.isArray(body.message)) message = body.message.join('; ');
    }
    const errorName =
      'error' in body && typeof body.error === 'string' ? body.error : label;
    // Preserve fields such as retryAt; the base filter owns headers-sent handling.
    super.catch(
      new HttpException(
        { ...body, statusCode, error: errorName, message },
        statusCode,
      ),
      host,
    );
  }
}
