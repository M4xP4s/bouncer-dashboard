import { SocketTimeoutError } from 'redis';
import { mockDeep } from 'vitest-mock-extended';
import type { RedisClient } from '../redis/redis.module.js';
import {
  generatedUser,
  seedBatch,
  seedGeneratedUsers,
  SeedRefused,
  type SeedUser,
  tokenDigest,
} from './seed-users.js';

const ADMIN_TOKEN = 'admin-token';
const redis = mockDeep<RedisClient>();

describe('generatedUser', () => {
  it.each([
    [1, 'user-01', 'demo-token-01'],
    [12, 'user-12', 'demo-token-12'],
    [1000, 'user-1000', 'demo-token-1000'],
  ])('numbers user %i with at least two digits', (index, userId, token) => {
    expect(generatedUser(index)).toEqual({ userId, token });
  });
});

describe('tokenDigest', () => {
  it('is the SHA-256 of the token in hexadecimal', () => {
    expect(tokenDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('seedBatch', () => {
  const valid = generatedUser(1);

  it.each<[string, SeedUser[]]>([
    ['a user ID with a colon', [{ userId: 'user:1', token: 'token-1' }]],
    ['an empty user ID', [{ userId: '', token: 'token-1' }]],
    ['a token with a space', [{ userId: 'user-1', token: 'a b' }]],
    ['a repeated user ID', [valid, { ...valid, token: 'other-token' }]],
    ['a repeated token', [valid, { ...valid, userId: 'user-other' }]],
    ['the admin token', [{ userId: 'user-1', token: ADMIN_TOKEN }]],
  ])('refuses a batch with %s before Redis is called', async (_case, users) => {
    await expect(seedBatch(redis, users, ADMIN_TOKEN)).rejects.toThrow(
      SeedRefused,
    );
    expect(redis.watch).not.toHaveBeenCalled();
  });

  it('refuses more than 100 users in one batch', async () => {
    const users = Array.from({ length: 101 }, (_, index) =>
      generatedUser(index + 1),
    );

    await expect(seedBatch(redis, users, ADMIN_TOKEN)).rejects.toThrow(
      'at most 100',
    );
    expect(redis.watch).not.toHaveBeenCalled();
  });

  it('never repeats a token in a refusal', async () => {
    const users = [valid, { userId: 'user-other', token: valid.token }];

    await expect(seedBatch(redis, users, ADMIN_TOKEN)).rejects.not.toThrow(
      valid.token,
    );
  });
});

describe('seedGeneratedUsers', () => {
  it('counts only the batches Redis confirmed when a later one fails', async () => {
    const multi = mockDeep<ReturnType<RedisClient['multi']>>();
    multi.hSet.mockReturnValue(multi);
    multi.zAdd.mockReturnValue(multi);
    multi.exec
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new SocketTimeoutError(3000));
    redis.multi.mockReturnValue(multi);
    redis.hmGet.mockResolvedValue(Array.from({ length: 100 }, () => null));
    const progress = { processed: 0, added: 0 };

    await expect(
      seedGeneratedUsers(redis, 200, ADMIN_TOKEN, progress),
    ).rejects.toThrow(SocketTimeoutError);
    expect(progress).toEqual({ processed: 100, added: 100 });
  });
});
