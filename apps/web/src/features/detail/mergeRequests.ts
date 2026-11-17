import type { RequestRecord } from '@app/contracts';
import { latestRequests } from '../../lib/latestRequests.ts';
import { DAY_MS } from '../../lib/time.ts';

/** The loaded and the live records of the past 24 hours, as one list. */
export function mergeRequests(
  detail: readonly RequestRecord[],
  live: readonly RequestRecord[],
  now: number,
): RequestRecord[] {
  const dayAgo = now - DAY_MS;
  const recent = [...detail, ...live].filter(
    (record) => Date.parse(record.at) > dayAgo,
  );
  return latestRequests(recent);
}
