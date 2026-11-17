import type { RequestRecord } from '@app/contracts';

/** Last copy wins; both the live buffer and displayed history keep the newest 100. */
export function latestRequests(
  records: readonly RequestRecord[],
): RequestRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return [...byId.values()]
    .sort((a, b) => {
      const timeDifference = Date.parse(b.at) - Date.parse(a.at);
      if (timeDifference !== 0) return timeDifference;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })
    .slice(0, 100);
}
