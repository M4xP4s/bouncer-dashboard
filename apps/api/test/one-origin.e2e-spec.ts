import { existsSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { io } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { ADMIN_TOKEN } from './support/application.js';

const PAGE = new URL('../../web/dist/index.html', import.meta.url);

describe('page, API and socket on one origin', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    if (!existsSync(PAGE)) {
      throw new Error('These cases need the built page: run `npm run build`.');
    }
    // Built as main.ts builds it: a testing module chooses the static file
    // loader before it has an HTTP server, and then serves no files.
    app = await NestFactory.create(AppModule, { logger: false });
    await configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the dashboard at /', async () => {
    const response = await request(url).get('/').expect(200);

    expect(response.type).toBe('text/html');
    expect(response.text).toContain('<title>Rate limit dashboard</title>');
  });

  it('answers an unknown API path with a JSON 404, not the page', async () => {
    const response = await request(url).get('/api/no-such-route').expect(404);

    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Cannot GET /api/no-such-route',
    });
  });

  it('lets a dashboard connect over polling under /socket.io', async () => {
    const socket = io(url, {
      auth: { token: ADMIN_TOKEN },
      transports: ['polling'],
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
    } finally {
      socket.disconnect();
    }
  });
});
