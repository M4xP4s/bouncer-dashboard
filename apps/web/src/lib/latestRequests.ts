import type { RequestRecord } from '@app/contracts';

const KEPT_REQUESTS = 100;

function newestFirst(a: RequestRecord, b: RequestRecord): number {
  const timeDifference = Date.parse(b.at) - Date.parse(a.at);
  if (timeDifference !== 0) return timeDifference;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** One record per ID, the last copy winning; newest first, capped. */
export function latestRequests(
  records: readonly RequestRecord[],
): RequestRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return [...byId.values()].sort(newestFirst).slice(0, KEPT_REQUESTS);
}
