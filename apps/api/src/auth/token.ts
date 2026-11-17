import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Compares a presented credential with the expected one in constant time.
 *
 * `===` stops at the first character that differs, so the time it takes
 * tells a caller how much of a guess was right. Hashing both sides first
 * gives `timingSafeEqual` two buffers of equal length, which it requires,
 * without revealing the length of the expected value.
 */
export function sameToken(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Parse a single HTTP bearer credential. */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
}
