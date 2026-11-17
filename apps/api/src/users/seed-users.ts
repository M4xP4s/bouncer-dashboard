import { createHash } from 'node:crypto';
import { WatchError } from 'redis';
import { TOKEN, USER_ID } from '../config/config.js';
import type { RedisClient } from '../redis/redis.module.js';

/** The registry keys; none expires. */
export const REGISTRY_KEYS = {
  ids: 'rl:registry:ids',
  users: 'rl:registry:users',
  tokens: 'rl:registry:tokens',
};

export const SEED_BATCH_SIZE = 100;
// A retry follows a write by another registering process; ten in a row means
// contention that a rerun should resolve instead.
const SEED_ATTEMPTS = 10;
const GENERATED_NUMBER_DIGITS = 2;

export interface SeedUser {
  userId: string;
  token: string;
}

/** Users looked at and users added so far, kept when a later batch fails. */
export interface SeedProgress {
  processed: number;
  added: number;
}

/** A refusal whose message names no credential, so it can be printed. */
export class SeedRefused extends Error {}

// Only the digest is stored, so a copy of Redis gives no credential away.
export const tokenDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** `user-01` with `demo-token-01`, numbered from 1. */
export function generatedUser(index: number): SeedUser {
  const number = String(index).padStart(GENERATED_NUMBER_DIGITS, '0');
  return { userId: `user-${number}`, token: `demo-token-${number}` };
}

/** Registers user-01 to user-`count` in batches, updating `progress`. */
export async function seedGeneratedUsers(
  redis: RedisClient,
  count: number,
  adminToken: string,
  progress: SeedProgress = { processed: 0, added: 0 },
): Promise<SeedProgress> {
  while (progress.processed < count) {
    const size = Math.min(SEED_BATCH_SIZE, count - progress.processed);
    const users = Array.from({ length: size }, (_, index) =>
      generatedUser(progress.processed + index + 1),
    );
    progress.added += await seedBatch(redis, users, adminToken);
    progress.processed += size;
  }
  return progress;
}

/**
 * Registers the users of one batch that are not registered yet; returns how
 * many it added. WATCH belongs to the connection, so the caller must own
 * `redis` exclusively.
 */
export async function seedBatch(
  redis: RedisClient,
  users: SeedUser[],
  adminToken: string,
): Promise<number> {
  assertValidBatch(users, adminToken);
  for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt++) {
    const added = await watchedAttempt(redis, users);
    if (added !== undefined) return added;
  }
  throw new SeedRefused('Concurrent seeding did not settle; rerun to resume.');
}

function assertValidBatch(users: SeedUser[], adminToken: string): void {
  if (users.length > SEED_BATCH_SIZE) {
    throw new Error(`A seed batch holds at most ${SEED_BATCH_SIZE} users.`);
  }
  const userIds = new Set<string>();
  const tokens = new Set<string>();
  users.forEach((user, index) => {
    const problem = seedUserProblem(user, userIds, tokens, adminToken);
    if (problem) {
      throw new SeedRefused(`Seed user ${index + 1} of the batch ${problem}.`);
    }
    userIds.add(user.userId);
    tokens.add(user.token);
  });
}

/** Why a user cannot be in the batch, or undefined when it can. */
function seedUserProblem(
  { userId, token }: SeedUser,
  userIds: ReadonlySet<string>,
  tokens: ReadonlySet<string>,
  adminToken: string,
): string | undefined {
  if (!USER_ID.test(userId) || !TOKEN.test(token)) return 'is malformed';
  if (userIds.has(userId) || tokens.has(token)) return 'repeats an identity';
  if (token === adminToken) return 'uses the admin token';
  return undefined;
}

/** Returns the users added, or undefined when another writer intervened. */
async function watchedAttempt(
  redis: RedisClient,
  users: SeedUser[],
): Promise<number | undefined> {
  await redis.watch(Object.values(REGISTRY_KEYS));
  try {
    const newUsers = await unregisteredUsers(redis, users);
    if (newUsers.length > 0) await register(redis, newUsers);
    return newUsers.length;
  } catch (error) {
    if (!(error instanceof WatchError)) throw error;
    return undefined;
  } finally {
    // EXEC ends the watch; any other way out must end it too.
    if (redis.isReady) await redis.unwatch();
  }
}

/** The users whose ID is not registered; refuses a token another user holds. */
async function unregisteredUsers(
  redis: RedisClient,
  users: SeedUser[],
): Promise<SeedUser[]> {
  const userIds = users.map(({ userId }) => userId);
  const digests = users.map(({ token }) => tokenDigest(token));
  const knownDigests = await redis.hmGet(REGISTRY_KEYS.users, userIds);
  const tokenOwners = await redis.hmGet(REGISTRY_KEYS.tokens, digests);
  // A registered ID keeps its token, so only new IDs are checked.
  const taken = users.find(
    (_, index) => knownDigests[index] === null && tokenOwners[index] !== null,
  );
  if (taken) {
    throw new SeedRefused(
      `The token of ${taken.userId} belongs to another user.`,
    );
  }
  return users.filter((_, index) => knownDigests[index] === null);
}

/** Writes the three registry entries of every user in one transaction. */
async function register(redis: RedisClient, users: SeedUser[]): Promise<void> {
  const multi = redis.multi();
  for (const { userId, token } of users) {
    const digest = tokenDigest(token);
    multi
      .hSet(REGISTRY_KEYS.users, userId, digest)
      .hSet(REGISTRY_KEYS.tokens, digest, userId)
      .zAdd(REGISTRY_KEYS.ids, { score: 0, value: userId });
  }
  await multi.exec();
}
