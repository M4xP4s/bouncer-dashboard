import 'reflect-metadata';
import { type INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import request from 'supertest';
import { SampleController } from './sample.controller.js';
import { ApiErrorFilter } from '../api-error.filter.js';
import { UserTokenGuard } from '../auth/user-token.guard.js';
import { LiveGateway } from '../live/live.gateway.js';
import { RateLimitInterceptor } from '../rate-limit/rate-limit.interceptor.js';
import {
  type Admission,
  RateLimitStore,
  StoreUnavailable,
} from '../rate-limit/rate-limit.store.js';
import { buildRow } from '../rate-limit/row.js';
import { UserRegistry } from '../users/user-registry.js';

const now = Date.parse('2026-11-16T10:42:00.000Z');
const admission: Admission = {
  outcome: 'allowed',
  requestId: 'request-1',
  generation: 0,
  row: buildRow('user', [1, null, null, null, { v: '1' }], now),
};

describe('sample HTTP', () => {
  let app: INestApplication;
  const store = mockDeep<RateLimitStore>();
  const live = mockDeep<LiveGateway>();
  const registry = mockDeep<UserRegistry>();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    mockReset(store);
    mockReset(live);
    mockReset(registry);
    registry.identify.mockResolvedValue('user');
    store.admit.mockResolvedValue(admission);
    store.recordOutcome.mockResolvedValue(false);
    const module = await Test.createTestingModule({
      controllers: [SampleController],
      providers: [
        UserTokenGuard,
        RateLimitInterceptor,
        { provide: APP_FILTER, useClass: ApiErrorFilter },
        { provide: RateLimitStore, useValue: store },
        { provide: LiveGateway, useValue: live },
        { provide: UserRegistry, useValue: registry },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('GET /api/sample/fail answers 500 after allowed admission and bookkeeping', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/sample/fail')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Sample failure.',
    });
    expect(response.headers['x-count']).toBe('99');
    expect(store.admit).toHaveBeenCalledExactlyOnceWith('user', now);
    expect(store.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      'user',
      now,
      admission,
    );
    expect(live.emitUpdate).toHaveBeenCalledExactlyOnceWith({
      cause: 'request',
      at: new Date(now).toISOString(),
      row: admission.row,
      request: {
        id: 'request-1',
        at: new Date(now).toISOString(),
        outcome: 'allowed',
        remaining: 99,
      },
    });
    expect(live.emitLimitExceeded).not.toHaveBeenCalled();
  });

  it('keeps an unexpected defect a private 500 with the complete ApiError shape', async () => {
    store.admit.mockRejectedValue(new TypeError('private diagnostic'));
    const response = await request(app.getHttpServer())
      .get('/api/sample')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
    expect(response.headers['x-count']).toBeUndefined();
    expect(store.recordOutcome).not.toHaveBeenCalled();
    expect(live.emitUpdate).not.toHaveBeenCalled();
  });

  it('preserves the admission-outage 503 message and omits x-count', async () => {
    store.admit.mockRejectedValue(
      new StoreUnavailable(new Error('private transport details')),
    );
    const response = await request(app.getHttpServer())
      .get('/api/sample')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'The request was not processed. It may be retried.',
    });
    expect(response.headers['x-count']).toBeUndefined();
    expect(store.recordOutcome).not.toHaveBeenCalled();
    expect(live.emitUpdate).not.toHaveBeenCalled();
  });

  it('preserves retry metadata when normalizing the rejection response', async () => {
    store.admit.mockResolvedValue({
      ...admission,
      outcome: 'denied',
      row: buildRow('user', [100, null, null, null, {}], now),
    });
    const response = await request(app.getHttpServer())
      .get('/api/sample')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message:
        'Rate limit of 100 requests per hour exceeded. Try again at 11:00:00 UTC.',
      retryAt: '2026-11-16T11:00:00.000Z',
      retryAfterSeconds: 1080,
    });
    expect(response.headers['x-count']).toBe('0');
    expect(response.headers['retry-after']).toBe('1080');
  });
});
