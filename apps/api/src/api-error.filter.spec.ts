import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  type HttpServer,
  Logger,
} from '@nestjs/common';
import { mock, mockDeep } from 'vitest-mock-extended';
import { ApiErrorFilter } from './api-error.filter.js';

/** A filter on a mocked HTTP adapter, and the response object it replies on. */
function setUp({ headersSent = false } = {}) {
  const adapter = mock<HttpServer>();
  const host = mockDeep<ArgumentsHost>();
  const response = {};
  host.getArgByIndex.mockReturnValue(response);
  adapter.isHeadersSent.mockReturnValue(headersSent);
  return { filter: new ApiErrorFilter(adapter), adapter, host, response };
}

describe('ApiErrorFilter', () => {
  it.each([
    [
      new HttpException('Not here.', 404),
      { statusCode: 404, error: 'Not Found', message: 'Not here.' },
    ],
    [
      new BadRequestException(['One problem.', 'Another problem.']),
      {
        statusCode: 400,
        error: 'Bad Request',
        message: 'One problem.; Another problem.',
      },
    ],
    [
      Object.assign(new Error('private middleware details'), {
        status: 503,
        statusCode: 503,
        expose: false,
      }),
      {
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Service Unavailable',
      },
    ],
  ])(
    'normalizes %s without losing HTTP classification or exposing hidden middleware details',
    (error, body) => {
      const { filter, adapter, host, response } = setUp();

      filter.catch(error, host);

      expect(adapter.reply).toHaveBeenCalledExactlyOnceWith(
        response,
        body,
        body.statusCode,
      );
    },
  );

  it('answers an unexpected error with a 500 and logs the cause instead of sending it', () => {
    const { filter, adapter, host, response } = setUp();
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const defect = new Error('private detail');

    filter.catch(defect, host);

    expect(adapter.reply).toHaveBeenCalledExactlyOnceWith(
      response,
      {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
      },
      500,
    );
    expect(log).toHaveBeenCalledExactlyOnceWith('Unexpected API error', defect);
    log.mockRestore();
  });

  it('keeps the extra fields of an exception, such as a retry time', () => {
    const { filter, adapter, host, response } = setUp();
    const retryAt = '2026-01-01T00:00:00.000Z';

    filter.catch(
      new HttpException({ message: 'Slow down.', retryAt }, 429),
      host,
    );

    expect(adapter.reply).toHaveBeenCalledExactlyOnceWith(
      response,
      {
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Slow down.',
        retryAt,
      },
      429,
    );
  });

  it('does not reply again once the headers are sent', () => {
    const { filter, adapter, host } = setUp({ headersSent: true });

    filter.catch(new HttpException('Late.', 500), host);

    expect(adapter.reply).not.toHaveBeenCalled();
  });
});
