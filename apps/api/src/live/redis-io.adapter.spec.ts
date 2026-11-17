import type { INestApplicationContext } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import {
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../redis/redis.module.js';
import {
  RedisIoAdapter,
  reportInsteadOfReject,
  resubscribeWhenReady,
} from './redis-io.adapter.js';

vi.mock('../redis/redis.module.js', () => ({
  connectRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe('reportInsteadOfReject', () => {
  it('reports a failed publish and resolves', async () => {
    const client = mockDeep<RedisClient>();
    const offline = new Error('The client is offline');
    client.publish.mockRejectedValue(offline);
    const onError = vi.fn();

    reportInsteadOfReject(client, ['publish'], onError);

    // The adapter does not await this call; a rejection would end the process.
    await expect(client.publish('channel', 'message')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(offline);
  });

  it('still publishes while Redis answers', async () => {
    const client = mockDeep<RedisClient>();
    const publish = client.publish.mockResolvedValue(1);
    const onError = vi.fn();

    reportInsteadOfReject(client, ['publish'], onError);

    await expect(client.publish('channel', 'message')).resolves.toBe(1);
    expect(publish).toHaveBeenCalledWith('channel', 'message');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('resubscribeWhenReady', () => {
  it('reports a failed subscribe and sends it again once the connection is ready', async () => {
    const client = mockDeep<RedisClient>();
    const lost = new Error('Socket closed unexpectedly');
    const subscribe = client.subscribe
      .mockRejectedValueOnce(lost)
      .mockResolvedValueOnce(undefined);
    const readyCallbacks: (() => void)[] = [];
    client.once.mockImplementation((event, callback) => {
      if (event === 'ready') readyCallbacks.push(callback);
      return client;
    });
    const onError = vi.fn();
    const listener = vi.fn();

    resubscribeWhenReady(client, ['subscribe'], onError);

    await expect(
      client.subscribe('channel', listener),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(lost);
    expect(subscribe).toHaveBeenCalledOnce();

    for (const callback of readyCallbacks) callback();
    expect(subscribe).toHaveBeenNthCalledWith(2, 'channel', listener);
  });
});

describe('RedisIoAdapter.connect', () => {
  it('closes the publisher when the subscriber cannot connect', async () => {
    const publisher = mockDeep<RedisClient>();
    const refused = new Error('Cannot connect to Redis at localhost:6379');
    vi.mocked(connectRedis)
      .mockResolvedValueOnce(publisher)
      .mockRejectedValueOnce(refused);

    const connecting = RedisIoAdapter.connect(
      mockDeep<INestApplicationContext>(),
      'redis://localhost:6379',
    );

    await expect(connecting).rejects.toBe(refused);
    expect(closeRedis).toHaveBeenCalledExactlyOnceWith(publisher);
  });
});
