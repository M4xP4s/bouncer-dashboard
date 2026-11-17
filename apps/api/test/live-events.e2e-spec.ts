import type { RateUpdateEvent } from '@app/contracts';
import { useFrozenApplication } from './support/application.js';

describe('request -> Redis -> event', () => {
  const application = useFrozenApplication();

  it('answers an admitted request with x-count and sends its row to a dashboard as rate:update', async () => {
    const api = application();
    const socket = await api.dashboard();
    const received = new Promise<RateUpdateEvent>((resolve) =>
      socket.once('rate:update', resolve),
    );

    const response = await api.sample().expect(200);

    expect(response.headers['x-count']).toBe('99');
    expect(response.body).toEqual({
      ok: true,
      userId: 'user-01',
      at: '2099-01-01T10:42:00.000Z',
    });
    // The event carries the whole row: a dashboard needs no second request.
    expect(await received).toEqual({
      cause: 'request',
      at: '2099-01-01T10:42:00.000Z',
      row: {
        userId: 'user-01',
        used: 1,
        limit: 100,
        extra: 0,
        total: 100,
        remaining: 99,
        status: 'OK',
        resetAt: '2099-01-01T11:00:00.000Z',
        lastRequestAt: '2099-01-01T10:42:00.000Z',
        lastResetAt: '2099-01-01T10:00:00.000Z',
        suspendedUntil: null,
        version: 1,
      },
      request: {
        id: expect.any(String),
        at: '2099-01-01T10:42:00.000Z',
        outcome: 'allowed',
        remaining: 99,
      },
    });
  });
});
