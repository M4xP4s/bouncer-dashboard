import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RequestOutcome } from '@app/contracts';
import { lastValueFrom, of, throwError } from 'rxjs';
import { mock } from 'vitest-mock-extended';
import type { LiveGateway } from '../live/live.gateway.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import {
  type Admission,
  type RateLimitStore,
  StoreUnavailable,
} from './rate-limit.store.js';
import { buildRow } from './row.js';

const now = Date.parse('2026-11-16T10:42:00.000Z');

/** What the store answers for a request that leaves the user at `used`. */
const admission = (outcome: RequestOutcome, used: number): Admission => ({
  outcome,
  requestId: 'request-1',
  generation: 0,
  row: buildRow('user-01', [used, null, null, null, { v: `${used}` }], now),
});

function setup(identity: { userId?: unknown } = { userId: 'user-01' }) {
  const store = mock<RateLimitStore>();
  store.recordOutcome.mockResolvedValue(false);
  const gateway = mock<LiveGateway>();
  const response = { setHeader: vi.fn() };
  const http = mock<ReturnType<ExecutionContext['switchToHttp']>>();
  http.getRequest.mockReturnValue(identity);
  http.getResponse.mockReturnValue(response);
  const context = mock<ExecutionContext>();
  context.switchToHttp.mockReturnValue(http);
  const next = mock<CallHandler>();
  next.handle.mockReturnValue(of('handler result'));
  const interceptor = new RateLimitInterceptor(store, gateway);
  /** Runs the interceptor and the handler behind it. */
  const run = async () =>
    lastValueFrom(await interceptor.intercept(context, next));
  return { store, gateway, response, next, run };
}

describe('RateLimitInterceptor', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ now });
    logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits the first request with x-count 99 and runs the handler', async () => {
    const { store, response, next, run } = setup();
    store.admit.mockResolvedValue(admission('allowed', 1));

    await expect(run()).resolves.toBe('handler result');

    // The user from the guard and one reading of the clock.
    expect(store.admit).toHaveBeenCalledExactlyOnceWith('user-01', now);
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith('x-count', '99');
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('records the outcome at the time of the decision, although the clock has moved on', async () => {
    const { store, run } = setup();
    const admitted = admission('allowed', 1);
    store.admit.mockImplementation(() => {
      vi.setSystemTime(now + 1);
      return Promise.resolve(admitted);
    });

    await run();

    expect(store.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      'user-01',
      now,
      admitted,
    );
  });

  it.each([{}, { userId: null }, { userId: '' }, { userId: 42 }])(
    'rejects missing or invalid guard identity %j without consuming quota',
    async (identity) => {
      const { store, gateway, response, next, run } = setup(identity);
      const failure: unknown = await run().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HttpException);
      if (!(failure instanceof HttpException))
        throw new Error('Expected HTTP error');
      expect(failure.getStatus()).toBe(401);
      expect(store.admit).not.toHaveBeenCalled();
      expect(store.recordOutcome).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(gateway.emitUpdate).not.toHaveBeenCalled();
      expect(gateway.emitLimitExceeded).not.toHaveBeenCalled();
      expect(next.handle).not.toHaveBeenCalled();
    },
  );

  it('awaits recording an admission before the handler runs', async () => {
    const { store, next, run } = setup();
    const admitted = admission('allowed', 1);
    store.admit.mockResolvedValue(admitted);
    let finishRecording: ((shouldNotify: boolean) => void) | undefined;
    const recording = new Promise<boolean>((resolve) => {
      finishRecording = resolve;
    });
    const started = new Promise<void>((resolve) => {
      store.recordOutcome.mockImplementation(() => {
        resolve();
        return recording;
      });
    });

    const result = run();
    await started;
    expect(next.handle).not.toHaveBeenCalled();
    if (!finishRecording) {
      throw new Error('Recording resolver was not initialized');
    }
    finishRecording(false);
    await expect(result).resolves.toBe('handler result');

    expect(store.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      'user-01',
      now,
      admitted,
    );
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('still runs the handler with x-count and an update when recording an admission fails', async () => {
    const { store, gateway, response, next, run } = setup();
    const cause = new Error('bookkeeping connection lost');
    store.admit.mockResolvedValue(admission('allowed', 1));
    store.recordOutcome.mockRejectedValue(new StoreUnavailable(cause));

    await expect(run()).resolves.toBe('handler result');

    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith('x-count', '99');
    expect(next.handle).toHaveBeenCalledOnce();
    expect(gateway.emitUpdate).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith('request bookkeeping failed', cause);
  });

  it('keeps the admission when its handler fails', async () => {
    const { store, response, next, run } = setup();
    const admitted = admission('allowed', 1);
    const failure = new Error('handler failed');
    store.admit.mockResolvedValue(admitted);
    next.handle.mockReturnValue(throwError(() => failure));

    await expect(run()).rejects.toBe(failure);

    expect(store.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      'user-01',
      now,
      admitted,
    );
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith('x-count', '99');
  });

  it('sends rate:update with the row and the request of an admission', async () => {
    const { store, gateway, run } = setup();
    const admitted = admission('allowed', 1);
    store.admit.mockResolvedValue(admitted);

    await run();

    expect(gateway.emitUpdate).toHaveBeenCalledExactlyOnceWith({
      cause: 'request',
      at: '2026-11-16T10:42:00.000Z',
      row: admitted.row,
      request: {
        id: 'request-1',
        at: '2026-11-16T10:42:00.000Z',
        outcome: 'allowed',
        remaining: 99,
      },
    });
  });

  it('answers a rejection with 429, the retry time and x-count 0', async () => {
    const { store, gateway, response, next, run } = setup();
    const rejected = admission('denied', 100);
    store.admit.mockResolvedValue(rejected);

    const failure = (await run().catch((e) => e)) as HttpException;

    expect(failure).toBeInstanceOf(HttpException);
    expect(failure.getStatus()).toBe(429);
    expect(failure.getResponse()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message:
        'Rate limit of 100 requests per hour exceeded. Try again at 11:00:00 UTC.',
      retryAt: '2026-11-16T11:00:00.000Z',
      retryAfterSeconds: 1080,
    });
    expect(response.setHeader.mock.calls).toEqual([
      ['Retry-After', '1080'],
      ['x-count', '0'],
    ]);
    expect(next.handle).not.toHaveBeenCalled();
    expect(store.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      'user-01',
      now,
      rejected,
    );
    // Not an admission, so not a rate:update.
    expect(gateway.emitUpdate).not.toHaveBeenCalled();
    // Recording did not report a first rejection, so there is no alert.
    expect(gateway.emitLimitExceeded).not.toHaveBeenCalled();
  });

  it('admits over the cap while throttling is suspended, with x-count 0', async () => {
    const { store, gateway, response, next, run } = setup();
    store.admit.mockResolvedValue(admission('bypassed', 101));

    await expect(run()).resolves.toBe('handler result');

    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith('x-count', '0');
    expect(next.handle).toHaveBeenCalledOnce();
    expect(gateway.emitUpdate.mock.calls[0][0].request).toMatchObject({
      outcome: 'bypassed',
    });
  });

  it('announces the first rejection with its row, retry time and request', async () => {
    const { store, gateway, run } = setup();
    const rejected = admission('denied', 100);
    store.admit.mockResolvedValue(rejected);
    store.recordOutcome.mockResolvedValue(true);

    await expect(run()).rejects.toBeInstanceOf(HttpException);

    expect(gateway.emitLimitExceeded).toHaveBeenCalledExactlyOnceWith({
      at: '2026-11-16T10:42:00.000Z',
      row: rejected.row,
      retryAt: rejected.row.resetAt,
      request: {
        id: rejected.requestId,
        at: '2026-11-16T10:42:00.000Z',
        outcome: 'denied',
        remaining: 0,
      },
    });
    expect(gateway.emitUpdate).not.toHaveBeenCalled();
  });

  it('answers 503 without running the handler when the store is unavailable', async () => {
    const { store, response, next, run } = setup();
    const cause = new Error('The client is offline');
    store.admit.mockRejectedValue(new StoreUnavailable(cause));

    const failure = (await run().catch((e) => e)) as HttpException;

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    // No claim about the quota: the outcome of the transaction is unknown.
    expect(failure.getResponse()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'The request was not processed. It may be retried.',
    });
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(next.handle).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledExactlyOnceWith('admission failed', cause);
  });

  it('does not disguise a defect of ours as 503', async () => {
    const { store, run } = setup();
    const defect = new TypeError('undefined is not a function');
    store.admit.mockRejectedValue(defect);

    await expect(run()).rejects.toBe(defect);
  });

  it('still answers 429 and announces nothing when recording the rejection fails', async () => {
    const { store, gateway, run } = setup();
    store.admit.mockResolvedValue(admission('denied', 100));
    store.recordOutcome.mockRejectedValue(new StoreUnavailable(new Error()));

    const failure = (await run().catch((e) => e)) as HttpException;

    expect(failure.getStatus()).toBe(429);
    expect(logged).toHaveBeenCalledOnce();
    expect(gateway.emitLimitExceeded).not.toHaveBeenCalled();
    expect(gateway.emitUpdate).not.toHaveBeenCalled();
  });

  it.each(['allowed', 'denied'] as const)(
    'does not swallow a defect while recording %s',
    async (outcome) => {
      const { store, next, run } = setup();
      const defect = new TypeError('broken bookkeeping');
      store.admit.mockResolvedValue(admission(outcome, 100));
      store.recordOutcome.mockRejectedValue(defect);

      await expect(run()).rejects.toBe(defect);
      expect(next.handle).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
    },
  );
});
