import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { type INestApplication, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { UserRow } from '@app/contracts';
import request from 'supertest';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AdminController, SeededUserPipe } from './admin.controller.js';
import { AdminTokenGuard } from '../auth/admin-token.guard.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { LiveGateway } from '../live/live.gateway.js';
import {
  RateLimitStore,
  StoreUnavailable,
} from '../rate-limit/rate-limit.store.js';
import { buildRow } from '../rate-limit/row.js';
import { ApiErrorFilter } from '../api-error.filter.js';

const config = loadConfig({
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_TOKEN: 'admin',
  DEMO_USERS: 'user:token',
});
const now = Date.parse('2026-11-16T10:42:00.000Z');
const row = buildRow('user', [1, null, null, null, { v: '7' }], now);
const actions = [
  {
    method: 'post',
    path: 'reset',
    body: undefined,
    storeMethod: 'reset',
    args: ['user', now],
    cause: 'reset',
    validation: undefined,
  },
  {
    method: 'put',
    path: 'limit',
    body: { limit: 50 },
    storeMethod: 'setLimit',
    args: ['user', now, 50],
    cause: 'limit',
    validation: { field: 'limit', aboveMax: 10_001 },
  },
  {
    method: 'post',
    path: 'suspension',
    body: { minutes: 5 },
    storeMethod: 'suspend',
    args: ['user', now, 5],
    cause: 'suspend',
    validation: { field: 'minutes', aboveMax: 1441 },
  },
  {
    method: 'delete',
    path: 'suspension',
    body: undefined,
    storeMethod: 'unsuspend',
    args: ['user', now],
    cause: 'unsuspend',
    validation: undefined,
  },
  {
    method: 'post',
    path: 'extra',
    body: { amount: 20 },
    storeMethod: 'addExtra',
    args: ['user', now, 20],
    cause: 'extra',
    validation: { field: 'amount', aboveMax: 10_001 },
  },
] as const;
const userPath = (userId: string) => `/admin/users/${userId}`;

const listRoutes = [
  { method: 'get', path: '/admin/users' },
  { method: 'get', path: '/admin/analytics' },
] as const;

const userRoutes = [
  { method: 'get', path: userPath, body: undefined },
  {
    method: 'get',
    path: (userId: string) => `${userPath(userId)}/history?range=hour`,
    body: undefined,
  },
  ...actions.map(({ method, path, body }) => ({
    method,
    path: (userId: string) => `${userPath(userId)}/${path}`,
    body,
  })),
] as const;

const routes = [
  ...listRoutes,
  ...userRoutes.map(({ method, path }) => ({ method, path: path('user') })),
];

const bodyActions = actions.flatMap(({ method, path, validation }) =>
  validation ? [{ method, path, ...validation }] : [],
);
const storeMethods = [
  'snapshot',
  'detail',
  'history',
  'denied429',
  'reset',
  'setLimit',
  'suspend',
  'unsuspend',
  'addExtra',
] as const;
const invalidBodies = bodyActions.flatMap(
  ({ method, path, field, aboveMax }) => [
    { method, path, reason: 'missing value', body: {} },
    { method, path, reason: 'string value', body: { [field]: '5' } },
    { method, path, reason: 'fractional value', body: { [field]: 1.5 } },
    { method, path, reason: 'below minimum', body: { [field]: 0 } },
    { method, path, reason: 'above maximum', body: { [field]: aboveMax } },
    {
      method,
      path,
      reason: 'unknown field',
      body: { [field]: 1, unexpected: 1 },
    },
  ],
);

function expectApiError(
  response: { status: number; body: unknown },
  statusCode: number,
) {
  expect(response.status).toBe(statusCode);
  expect(response.body).toEqual({
    statusCode,
    error: expect.any(String),
    message: expect.any(String),
  });
}

describe('admin HTTP', () => {
  let app: INestApplication;
  let pipeTransform: ReturnType<typeof vi.spyOn>;
  const store = mockDeep<RateLimitStore>();
  const live = mockDeep<LiveGateway>();
  const responseFinished = vi.fn();

  function expectNoStoreOrEvent() {
    for (const method of storeMethods) {
      expect(store[method], method).not.toHaveBeenCalled();
    }
    expect(live.emitUpdate).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    mockReset(store);
    mockReset(live);
    responseFinished.mockClear();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    pipeTransform = vi.spyOn(SeededUserPipe.prototype, 'transform');
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: APP_FILTER, useClass: ApiErrorFilter },
        AdminTokenGuard,
        SeededUserPipe,
        { provide: APP_CONFIG, useValue: config },
        { provide: RateLimitStore, useValue: store },
        { provide: LiveGateway, useValue: live },
      ],
    }).compile();
    app = module.createNestApplication();
    // Observe server-side completion too: a premature response may still be
    // travelling to Supertest when the held store call is inspected.
    app.use((_req: Request, response: Response, next: NextFunction) => {
      response.once('finish', responseFinished);
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(
    routes.flatMap((route) => [
      { ...route, credential: 'missing', authorization: undefined },
      { ...route, credential: 'user token', authorization: 'Bearer token' },
    ]),
  )(
    '$method $path rejects $credential before pipes and store',
    async ({ method, path, authorization }) => {
      const call = request(app.getHttpServer())
        [method](path)
        .send({ bad: true });
      if (authorization) call.set('Authorization', authorization);
      const response = await call;

      expectApiError(response, 401);
      expect(pipeTransform).not.toHaveBeenCalled();
      expectNoStoreOrEvent();
    },
  );

  it.each(['Basic admin', 'Bearer admin extra', 'Bearer wrong'])(
    'rejects invalid credential %s',
    async (authorization) => {
      const response = await request(app.getHttpServer())
        .get('/admin/users/user')
        .set('Authorization', authorization);

      expectApiError(response, 401);
      expect(pipeTransform).not.toHaveBeenCalled();
      expectNoStoreOrEvent();
    },
  );

  it.each(
    userRoutes.map(({ path, ...route }) => ({
      ...route,
      path: path('missing'),
    })),
  )(
    '$method $path rejects unknown users before store',
    async ({ method, path, body }) => {
      const response = await request(app.getHttpServer())
        [method](path)
        .set('Authorization', 'Bearer admin')
        .send(body);

      expectApiError(response, 404);
      expect(pipeTransform).toHaveBeenCalledExactlyOnceWith(
        'missing',
        expect.objectContaining({ type: 'param', data: 'userId' }),
      );
      expectNoStoreOrEvent();
    },
  );

  it.each(invalidBodies)(
    '$method $path refuses $reason without store access',
    async ({ method, path, body }) => {
      const response = await request(app.getHttpServer())
        [method](`/admin/users/user/${path}`)
        .set('Authorization', 'Bearer admin')
        .send(body);

      expectApiError(response, 400);
      expectNoStoreOrEvent();
    },
  );

  it.each([
    { reason: 'missing', query: '' },
    { reason: 'unsupported', query: '?range=week' },
  ])('refuses a $reason history range', async ({ query }) => {
    const response = await request(app.getHttpServer())
      .get(`/admin/users/user/history${query}`)
      .set('Authorization', 'Bearer admin');

    expectApiError(response, 400);
    expectNoStoreOrEvent();
  });

  it.each(
    bodyActions.flatMap(({ method, path, field }) =>
      [
        'constructor',
        '__proto__',
        'prototype',
        'toString',
        'hasOwnProperty',
      ].map((key) => ({
        method,
        path,
        field,
        key,
      })),
    ),
  )(
    '$method $path rejects raw unknown field $key',
    async ({ method, path, field, key }) => {
      const response = await request(app.getHttpServer())
        [method](`/admin/users/user/${path}`)
        .set('Authorization', 'Bearer admin')
        .set('Content-Type', 'application/json')
        // A JSON string preserves __proto__ as an own key on the parsed body.
        .send(`{"${field}":5,"${key}":{"unexpected":true}}`);

      expectApiError(response, 400);
      expectNoStoreOrEvent();
    },
  );

  it('checks authentication before rejecting raw prototype-related keys', async () => {
    const response = await request(app.getHttpServer())
      .put('/admin/users/user/limit')
      .set('Content-Type', 'application/json')
      .send('{"limit":5,"__proto__":null}');

    expectApiError(response, 401);
    expect(pipeTransform).not.toHaveBeenCalled();
    expectNoStoreOrEvent();
  });

  it('keeps malformed JSON as a complete 400 before pipes and store', async () => {
    const response = await request(app.getHttpServer())
      .put('/admin/users/user/limit')
      .set('Content-Type', 'application/json')
      .send('{');

    expectApiError(response, 400);
    expect(pipeTransform).not.toHaveBeenCalled();
    expectNoStoreOrEvent();
  });

  it.each(actions)(
    '$cause awaits its write, then returns and emits the exact row',
    async (action) => {
      let completeWrite: ((value: UserRow) => void) | undefined;
      const write = new Promise<UserRow>((resolve) => {
        completeWrite = resolve;
      });
      if (!completeWrite)
        throw new Error('The write resolver was not initialized');
      const started = new Promise<void>((resolve) => {
        store[action.storeMethod].mockImplementation(() => {
          resolve();
          return write;
        });
      });
      const pending = Promise.resolve(
        request(app.getHttpServer())
          [action.method](`/admin/users/user/${action.path}`)
          .set('Authorization', 'Bearer admin')
          .send(action.body),
      );

      try {
        await started;
        // Drain the handler's queued continuations while its write is held.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(live.emitUpdate).not.toHaveBeenCalled();
        expect(responseFinished).not.toHaveBeenCalled();
      } finally {
        completeWrite(row);
        await pending;
      }

      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body).toEqual(row);
      expect(store[action.storeMethod]).toHaveBeenCalledExactlyOnceWith(
        ...action.args,
      );
      expect(live.emitUpdate).toHaveBeenCalledExactlyOnceWith({
        cause: action.cause,
        at: new Date(now).toISOString(),
        row,
        request: null,
      });
      expect(responseFinished).toHaveBeenCalledOnce();
    },
  );

  it.each(
    actions.flatMap((action) => [
      {
        ...action,
        failure: 'store outage',
        error: new StoreUnavailable(new Error('offline')),
        status: 503,
        message: 'The rate limit store did not answer.',
      },
      {
        ...action,
        failure: 'programming defect',
        error: new TypeError('bug'),
        status: 500,
        message: 'Internal server error',
      },
    ]),
  )('$cause maps $failure to $status without emitting', async (action) => {
    store[action.storeMethod].mockRejectedValue(action.error);
    const response = await request(app.getHttpServer())
      [action.method](`/admin/users/user/${action.path}`)
      .set('Authorization', 'Bearer admin')
      .send(action.body);

    expectApiError(response, action.status);
    expect(response.body).toMatchObject({ message: action.message });
    expect(store[action.storeMethod]).toHaveBeenCalledExactlyOnceWith(
      ...action.args,
    );
    expect(live.emitUpdate).not.toHaveBeenCalled();
  });
});
