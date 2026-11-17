import type { RequestRecord } from '@app/contracts';
import { latestRequests } from '../../lib/latestRequests.ts';

export function mergeRequests(
  detail: readonly RequestRecord[],
  live: readonly RequestRecord[],
  now: number,
): RequestRecord[] {
  return latestRequests(
    [...detail, ...live].filter(
      (record) => Date.parse(record.at) > now - 86400000,
    ),
  );
}
