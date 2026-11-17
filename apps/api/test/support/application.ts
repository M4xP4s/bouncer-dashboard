import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  ClientToServerEvents,
  RateLimitExceededEvent,
  RateUpdateEvent,
  ServerToClientEvents,
  UserDetail,
  UserRow,
} from '@app/contracts';
import { io, type Socket } from 'socket.io-client';
import request, { type Response } from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';
import { REDIS, type RedisClient } from '../../src/redis/redis.module.js';

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// In the future, so that Redis, which keeps the real clock, does not expire
// a key the application has just written under the frozen one.
export const TEST_NOW = Date.parse('2099-01-01T10:42:00.000Z');
export const ADMIN_TOKEN = 'test-admin-token';

export const windowStart = (now = Date.now()) =>
  Math.floor(now / HOUR_MS) * HOUR_MS;
export const NEXT_HOUR = windowStart(TEST_NOW) + HOUR_MS;
export const windowKey = (userId: string, now = Date.now()) =>
  `rl:win:${userId}:${windowStart(now)}`;

// A call that hangs fails its own test, not the whole run.
export const REQUEST_DEADLINE_MS = 6 * SECOND_MS;
const HANDSHAKE_TIMEOUT_MS = 2 * SECOND_MS;
const BARRIER_WAIT_MS = 2 * SECOND_MS;
// drainEvents spends this user's quota, so a test that drains events
// asserts on the other users only.
const BARRIER_TOKEN = 'test-token-06';
const BARRIER_USER_ID = 'User_06-TEST';

type DashboardSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Method = 'get' | 'post' | 'put' | 'delete';

// Supertest's JSON body is untyped; the tests assert the fields they read.
export const bodyOf = <T>(response: Response): T => response.body;

/** Starts the whole application on a free port, closing it if that fails. */
async function listen(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  try {
    await configureApp(app);
    await app.listen(0, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

function dashboardSocket(url: string, token: string | null): DashboardSocket {
  return io(url, {
    auth: token === null ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: HANDSHAKE_TIMEOUT_MS,
  });
}

/** The whole application on a free port, and the calls the tests make on it. */
export class TestApplication {
  private readonly sockets: DashboardSocket[] = [];

  private constructor(
    readonly app: INestApplication,
    readonly url: string,
    readonly redis: RedisClient,
  ) {}

  static async start(): Promise<TestApplication> {
    const app = await listen();
    const redis = app.get<RedisClient>(REDIS);
    return new TestApplication(app, await app.getUrl(), redis);
  }

  sample(token: string | null = 'test-token-01', path = '/api/sample') {
    return this.call('get', path, token);
  }

  admin(
    method: Method,
    path: string,
    body?: object,
    token: string | null = ADMIN_TOKEN,
  ) {
    const call = this.call(method, `/api/admin${path}`, token);
    return body === undefined ? call : call.send(body);
  }

  /** Sends `count` requests one after another; each must be admitted. */
  async admitInTurn(count: number, token = 'test-token-01') {
    for (let sent = 0; sent < count; sent++)
      await this.sample(token).expect(200);
  }

  sampleAtOnce(count: number, token = 'test-token-01') {
    return Promise.all(Array.from({ length: count }, () => this.sample(token)));
  }

  /** Sends `count` requests at once; each must be admitted. */
  async admitAtOnce(count: number, token = 'test-token-01') {
    await Promise.all(
      Array.from({ length: count }, () => this.sample(token).expect(200)),
    );
  }

  async snapshot() {
    return bodyOf<UserRow[]>(await this.admin('get', '/users').expect(200));
  }

  async snapshotRow(userId = 'user-01') {
    return (await this.snapshot()).find((row) => row.userId === userId);
  }

  async detail(userId = 'user-01') {
    return bodyOf<UserDetail>(
      await this.admin('get', `/users/${userId}`).expect(200),
    );
  }

  /** Connects a dashboard, or rejects with the server's refusal. */
  async dashboard(token: string | null = ADMIN_TOKEN) {
    const socket = dashboardSocket(this.url, token);
    this.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }

  disconnectSockets() {
    for (const socket of this.sockets.splice(0)) socket.disconnect();
  }

  async close() {
    this.disconnectSockets();
    await this.app.close();
  }

  /** `null` sends no `Authorization` header at all. */
  private call(method: Method, path: string, token: string | null) {
    const call = request(this.url)
      [method](path)
      .timeout({ deadline: REQUEST_DEADLINE_MS });
    return token === null ? call : call.set('Authorization', `Bearer ${token}`);
  }
}

/**
 * One application per file and an empty database before each test. Only
 * `Date` is faked, so Redis, sockets and timers keep their real clocks.
 */
export function useFrozenApplication() {
  let application: TestApplication | undefined;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TEST_NOW });
    application = await TestApplication.start();
  });
  beforeEach(async () => {
    vi.setSystemTime(TEST_NOW);
    await application?.redis.flushDb();
  });
  afterEach(() => application?.disconnectSockets());
  afterAll(async () => {
    vi.useRealTimers();
    const started = application;
    if (!started) return;
    // Keys written under the 2099 clock would otherwise outlive the run.
    await started.redis.flushDb().finally(() => started.close());
  });
  return () => {
    if (!application) throw new Error('The application did not start');
    return application;
  };
}

export const statusCount = (responses: Response[], status: number) =>
  responses.filter((response) => response.status === status).length;

export function observeDashboard(socket: DashboardSocket) {
  const updates: RateUpdateEvent[] = [];
  const exceeded: RateLimitExceededEvent[] = [];
  socket.on('rate:update', (event) => updates.push(event));
  socket.on('rate:limit_exceeded', (event) => exceeded.push(event));
  return { updates, exceeded };
}

export const requestUpdatesOf = (updates: RateUpdateEvent[], userId: string) =>
  updates.filter(
    (event) => event.cause === 'request' && event.row.userId === userId,
  );

export function requestIdsOf(updates: RateUpdateEvent[]): string[] {
  return updates.map(({ request }) => {
    if (request === null) throw new Error('A request event has no request');
    return request.id;
  });
}

/**
 * Returns once the socket has received every event sent before the call:
 * events arrive in order, so one more request's event is the barrier.
 */
export async function drainEvents(
  application: TestApplication,
  socket: DashboardSocket,
) {
  let cancelWait = () => {};
  const barrierReceived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The barrier event did not arrive')),
      BARRIER_WAIT_MS,
    );
    const onUpdate = (event: RateUpdateEvent) => {
      if (event.row.userId === BARRIER_USER_ID) resolve();
    };
    socket.on('rate:update', onUpdate);
    cancelWait = () => {
      clearTimeout(timer);
      socket.off('rate:update', onUpdate);
    };
  });
  try {
    await Promise.all([
      application.sample(BARRIER_TOKEN).expect(200),
      barrierReceived,
    ]);
  } finally {
    cancelWait();
  }
}
