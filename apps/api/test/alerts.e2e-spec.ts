import type { RateLimitExceededEvent } from '@app/contracts';
import { RateLimitStore } from '../src/rate-limit/rate-limit.store.js';
import {
  drainEvents,
  observeDashboard,
  TEST_NOW,
  useFrozenApplication,
  windowKey,
} from './support/application.js';

const BURST_SIZE = 20;

// Each action re-arms the alert at a limit of 2 with both slots used. The
// last two columns: the requests it then admits, and the stored window size
// when the next alert is due.
const REARMING_ACTIONS = [
  ['reset', 'post', '/reset', undefined, 2, 2],
  ['grant', 'post', '/extra', { amount: 1 }, 1, 3],
  ['raised limit', 'put', '/limit', { limit: 3 }, 1, 3],
  ['lowered limit', 'put', '/limit', { limit: 1 }, 0, 2],
  ['unchanged limit', 'put', '/limit', { limit: 2 }, 0, 2],
] as const;

// Each action in turn, after a burst has used up the alert; the capacity it
// gives back is filled before the next burst.
const BURST_SEQUENCE = [
  { method: 'post', path: '/extra', body: { amount: 1 }, capacity: 1 },
  { method: 'post', path: '/reset', body: undefined, capacity: 2 },
  { method: 'put', path: '/limit', body: { limit: 3 }, capacity: 1 },
  { method: 'put', path: '/limit', body: { limit: 1 }, capacity: 0 },
  { method: 'put', path: '/limit', body: { limit: 1 }, capacity: 0 },
] as const;

describe('alert generations', () => {
  const application = useFrozenApplication();

  it('alerts once per rejection burst; each capacity action re-arms without alerting itself', async () => {
    const api = application();
    const socket = await api.dashboard();
    const { exceeded } = observeDashboard(socket);
    /** Runs a step and returns the alerts the dashboard received for it. */
    const alertsDuring = async (step: () => Promise<unknown>) => {
      const alertsBefore = exceeded.length;
      await step();
      await drainEvents(api, socket);
      return exceeded.slice(alertsBefore);
    };
    const rejectBurst = () =>
      Promise.all(
        Array.from({ length: BURST_SIZE }, () => api.sample().expect(429)),
      );
    await api.admin('put', '/users/user-01/limit', { limit: 2 }).expect(200);
    await api.admitInTurn(2);

    const burstAlerts = [await alertsDuring(rejectBurst)];
    const actionAlerts: RateLimitExceededEvent[][] = [];
    for (const { method, path, body, capacity } of BURST_SEQUENCE) {
      const action = () =>
        api.admin(method, `/users/user-01${path}`, body).expect(200);
      actionAlerts.push(await alertsDuring(action));
      await api.admitInTurn(capacity);
      burstAlerts.push(await alertsDuring(rejectBurst));
    }

    expect(actionAlerts.flat()).toEqual([]);
    expect(burstAlerts.map((alerts) => alerts.length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    for (const [alert] of burstAlerts)
      expect(alert).toMatchObject({
        row: { userId: 'user-01', remaining: 0, status: 'Exceeded' },
        request: { outcome: 'denied' },
        retryAt: '2099-01-01T11:00:00.000Z',
      });
    const alertIds = exceeded.map((event) => event.request.id);
    expect(new Set(alertIds).size).toBe(6);
  });

  it.each(REARMING_ACTIONS)(
    'a rejection recorded late does not use up the alert of the generation after a %s',
    async (_name, method, path, body, capacity, stored) => {
      const api = application();
      const store = api.app.get(RateLimitStore);
      await api.admin('put', '/users/user-01/limit', { limit: 2 }).expect(200);
      await api.admitInTurn(2);
      const delayed = await store.admit('user-01', TEST_NOW);

      await api.admin(method, `/users/user-01${path}`, body).expect(200);
      const delayedAlerts = await store.recordOutcome(
        'user-01',
        TEST_NOW,
        delayed,
      );
      await api.admitInTurn(capacity);
      // The store's answer decides the alert; the interceptor only sends it,
      // which the burst case above shows end to end.
      const next = await store.admit('user-01', TEST_NOW);
      const nextAlerts = await store.recordOutcome('user-01', TEST_NOW, next);
      const repeated = await store.admit('user-01', TEST_NOW);
      const repeatedAlerts = await store.recordOutcome(
        'user-01',
        TEST_NOW,
        repeated,
      );

      expect(delayed).toMatchObject({ outcome: 'denied', generation: 1 });
      expect(delayedAlerts).toBe(true);
      expect(next).toMatchObject({ outcome: 'denied', generation: 2 });
      expect(nextAlerts).toBe(true);
      expect(repeated.outcome).toBe('denied');
      expect(repeatedAlerts).toBe(false);
      expect(await api.redis.zCard(windowKey('user-01'))).toBe(stored);
    },
  );
});
