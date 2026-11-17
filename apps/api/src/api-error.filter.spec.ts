import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  type HttpServer,
} from '@nestjs/common';
import { mock, mockDeep } from 'vitest-mock-extended';
import { ApiErrorFilter } from './api-error.filter.js';

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
      const adapter = mock<HttpServer>();
      const host = mockDeep<ArgumentsHost>();
      const response = {};
      host.getArgByIndex.mockReturnValue(response);
      adapter.isHeadersSent.mockReturnValue(false);

      new ApiErrorFilter(adapter).catch(error, host);

      expect(adapter.reply).toHaveBeenCalledExactlyOnceWith(
        response,
        body,
        body.statusCode,
      );
    },
  );
});
