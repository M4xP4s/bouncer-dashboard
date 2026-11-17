import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sameToken } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import {
  REDIS,
  closeRedis,
  connectRedis,
  type RedisClient,
} from '../redis/redis.module.js';
import { storeCall } from '../rate-limit/rate-limit.store.js';
import {
  REGISTRY_KEYS,
  SEED_BATCH_SIZE,
  seedBatch,
  tokenDigest,
  type SeedUser,
} from './seed-users.js';

const READ_BATCH_SIZE = 100;

/** One page of registered IDs, in ID order. */
export interface RegistryPage {
  /** Every registered user, not only this page. */
  total: number;
  userIds: string[];
}

/** Looks users up in Redis on every call; no process holds the whole list. */
@Injectable()
export class UserRegistry implements OnModuleInit {
  constructor(
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): Promise<void> {
    return this.importBootstrapUsers();
  }

  /** Registers the DEMO_USERS pairs; a refused batch stops the start-up. */
  async importBootstrapUsers(): Promise<void> {
    const users = [...this.config.userIdByToken].map(
      ([token, userId]): SeedUser => ({ userId, token }),
    );
    if (users.length === 0) return;
    // WATCH applies to a whole connection, so registering gets its own.
    const seedRedis = await connectRedis(this.config.redisUrl, 'registry');
    try {
      for (let start = 0; start < users.length; start += SEED_BATCH_SIZE) {
        const batch = users.slice(start, start + SEED_BATCH_SIZE);
        await seedBatch(seedRedis, batch, this.config.adminToken);
      }
    } finally {
      await closeRedis(seedRedis);
    }
  }

  /** The user ID the token is registered to, or null. */
  async identify(token: string): Promise<string | null> {
    // A token registered before the admin token changed never acts as a user.
    if (sameToken(token, this.config.adminToken)) return null;
    const digest = tokenDigest(token);
    return storeCall(this.redis, () =>
      this.redis.hGet(REGISTRY_KEYS.tokens, digest),
    );
  }

  async exists(userId: string): Promise<boolean> {
    const found = await storeCall(this.redis, () =>
      this.redis.hExists(REGISTRY_KEYS.users, userId),
    );
    return found === 1;
  }

  /** The IDs at `offset` and the registry size, read in one transaction. */
  async page(offset: number, size: number): Promise<RegistryPage> {
    const lastIndex = offset + size - 1;
    const [total, userIds] = await storeCall(this.redis, () =>
      this.redis
        .multi()
        .zCard(REGISTRY_KEYS.ids)
        .zRange(REGISTRY_KEYS.ids, offset, lastIndex)
        .execTyped(),
    );
    return { total, userIds };
  }

  /**
   * Every registered ID in order, a batch at a time. Stops at the last ID
   * registered when it began, so users added meanwhile cannot extend a read.
   */
  async *batches(): AsyncGenerator<string[]> {
    const [lastUserId] = await storeCall(this.redis, () =>
      this.redis.zRange(REGISTRY_KEYS.ids, -1, -1),
    );
    if (lastUserId === undefined) return;
    let lowerBound = '-';
    while (true) {
      const userIds = await this.idsAfter(lowerBound, lastUserId);
      if (userIds.length === 0) return;
      yield userIds;
      lowerBound = `(${userIds.at(-1)}`;
    }
  }

  private idsAfter(lowerBound: string, lastUserId: string): Promise<string[]> {
    return storeCall(this.redis, () =>
      this.redis.zRange(REGISTRY_KEYS.ids, lowerBound, `[${lastUserId}`, {
        BY: 'LEX',
        LIMIT: { offset: 0, count: READ_BATCH_SIZE },
      }),
    );
  }
}
