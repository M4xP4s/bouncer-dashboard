/**
 * The application's configuration, read from the environment once at startup.
 *
 * `loadConfig` is a pure function of the environment so it can be tested
 * without starting Nest. It reports every problem at once and throws, which
 * stops the process before it listens: a half-configured API that starts and
 * then fails per request is harder to notice than one that does not start.
 */

/** Validated configuration. */
export interface AppConfig {
  /** HTTP and socket port. */
  port: number;
  redisUrl: string;
  /** Demo authentication: the one admin credential. */
  adminToken: string;
  /** DEMO_USERS, registered at start-up: bearer token to user ID. May be empty. */
  userIdByToken: ReadonlyMap<string, string>;
}

/** Injection token for the validated configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

// A user ID becomes part of Redis key names (`rl:win:{u}:{h}`) and of URLs.
// Keeping it to these characters means it can never contain the `:` that
// separates the parts of a key, or anything that needs escaping in a path.
export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The characters RFC 6750 allows in a bearer token. No whitespace, and no
// `:` or `,`, which are the separators inside DEMO_USERS.
export const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

/** A redis:// or rediss:// URL with a host and, if given, a whole-number database. */
function isRedisUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname, pathname } = new URL(value);
  return (
    ['redis:', 'rediss:'].includes(protocol) &&
    hostname !== '' &&
    /^\/?\d*$/.test(pathname)
  );
}

/** Why a DEMO_USERS pair cannot be added, or undefined when it can. */
function demoUserProblem(
  pair: string[],
  userIds: ReadonlySet<string>,
  userIdByToken: ReadonlyMap<string, string>,
  adminToken: string,
): string | undefined {
  const [userId, token] = pair;
  if (pair.length !== 2 || !USER_ID.test(userId) || !TOKEN.test(token)) {
    return 'must be userId:token';
  }
  if (userIds.has(userId)) return 'repeats a user ID';
  // A user token equal to the admin token would make that user an admin.
  if (userIdByToken.has(token) || token === adminToken) return 'reuses a token';
  return undefined;
}

/**
 * Builds the configuration or throws one error that lists every problem.
 *
 * The messages name the variable and the position of a bad entry but never
 * repeat a value: tokens and a Redis URL with a password must not end up in
 * a log.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const problems: string[] = [];

  const port = Number(env.PORT);
  if (!/^\d+$/.test(env.PORT ?? '') || port < 1 || port > 65535) {
    problems.push('PORT must be a whole number from 1 to 65535');
  }

  const redisUrl = env.REDIS_URL ?? '';
  if (!isRedisUrl(redisUrl)) {
    problems.push('REDIS_URL must be a redis:// or rediss:// URL');
  }

  const adminToken = env.ADMIN_TOKEN ?? '';
  if (!TOKEN.test(adminToken)) {
    problems.push('ADMIN_TOKEN must be a non-empty bearer token');
  }

  const userIdByToken = new Map<string, string>();
  const userIds = new Set<string>();
  const entries = (env.DEMO_USERS ?? '').split(',').filter(Boolean);
  entries.forEach((entry, index) => {
    const pair = entry.split(':');
    const problem = demoUserProblem(pair, userIds, userIdByToken, adminToken);
    if (problem) {
      problems.push(`DEMO_USERS entry ${index + 1} ${problem}`);
      return;
    }
    const [userId, token] = pair;
    userIds.add(userId);
    userIdByToken.set(token, userId);
  });

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return { port, redisUrl, adminToken, userIdByToken };
}
