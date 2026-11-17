// The command behind `npm run seed:users`. It prints its progress as one JSON
// line, also after a failure, so a rerun can be judged.
import { createClient } from 'redis';
import { loadConfig } from '../config/config.js';
import { closeRedis, type RedisClient } from '../redis/redis.module.js';
import {
  REGISTRY_KEYS,
  SeedRefused,
  seedGeneratedUsers,
  type SeedProgress,
} from './seed-users.js';

const USAGE = 'Usage: npm run seed:users -- --count <whole number>';

function requestedCount(args: string[]): number {
  const [flag, value = '', ...rest] = args;
  const count = Number(value);
  const valid =
    flag === '--count' &&
    rest.length === 0 &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(count);
  if (!valid) throw new SeedRefused(USAGE);
  return count;
}

const SILENCE_LIMIT_MS = 3000;

const NO_ANSWER =
  `Redis could not be reached or did not answer within ${SILENCE_LIMIT_MS / 1000} s. ` +
  '"added" counts confirmed batches only; the batch in flight may have been ' +
  'stored. Check Redis, then run the command again: it only adds missing users.';

/**
 * A connection of its own that never waits for Redis: no offline queue, no
 * reconnect, and a deadline for the connection and for each silence.
 */
function seedClient(url: string): RedisClient {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: SILENCE_LIMIT_MS,
      socketTimeout: SILENCE_LIMIT_MS,
      reconnectStrategy: false,
    },
  });
  // An unheard `error` would end the process; the failed command reports it.
  client.on('error', () => {});
  return client;
}

// Set-up errors and refusals are ours and name no credential; a Redis error
// while seeding is not, so only its consequence is printed.
function printableMessage(error: unknown, redis?: RedisClient): string {
  if (error instanceof SeedRefused) return error.message;
  if (!redis && error instanceof Error) return error.message;
  if (redis && !redis.isReady) return NO_ANSWER;
  return 'Seeding failed; check Redis, then rerun to resume.';
}

const progress: SeedProgress = { processed: 0, added: 0 };
let redis: RedisClient | undefined;
try {
  const count = requestedCount(process.argv.slice(2));
  const config = loadConfig(process.env);
  redis = seedClient(config.redisUrl);
  await redis.connect();
  await seedGeneratedUsers(redis, count, config.adminToken, progress);
  const total = await redis.zCard(REGISTRY_KEYS.ids);
  console.log(JSON.stringify({ ...progress, total }));
} catch (error) {
  const message = printableMessage(error, redis);
  console.error(JSON.stringify({ ...progress, error: message }));
  process.exitCode = 1;
} finally {
  if (redis) await closeRedis(redis);
}
