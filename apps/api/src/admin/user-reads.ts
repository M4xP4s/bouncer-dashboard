import { Injectable } from '@nestjs/common';
import type {
  ActivePeriod,
  Analytics,
  ReadInterval,
  UserRow,
  UsersPage,
  UsersQuery,
} from '@app/contracts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../rate-limit/keys.js';
import { RateLimitStore } from '../rate-limit/rate-limit.store.js';
import { UserRegistry } from '../users/user-registry.js';
import { AnalyticsTally } from './analytics.js';

const ACTIVE_PERIOD_MS: Record<ActivePeriod, number> = {
  '5m': 5 * MINUTE_MS,
  '1h': HOUR_MS,
  '24h': DAY_MS,
};

interface Matches {
  rows: UserRow[];
  total: number;
}

type RowFilter = (row: UserRow) => boolean;

/** The user list and analytics, read from the registry and the rows. */
@Injectable()
export class UserReads {
  constructor(
    private readonly registry: UserRegistry,
    private readonly store: RateLimitStore,
  ) {}

  /** `now` is when the read starts; every row is built for that moment. */
  async page(query: UsersQuery, now: number): Promise<UsersPage> {
    const offset = (query.page - 1) * query.pageSize;
    const { rows, total } = isUnfiltered(query)
      ? await this.unfilteredPage(offset, query.pageSize, now)
      : await this.filteredPage(query, offset, now);
    const interval = readInterval(now);
    return {
      rows,
      total,
      page: query.page,
      pageSize: query.pageSize,
      ...interval,
    };
  }

  async analytics(now: number): Promise<Analytics> {
    const tally = new AnalyticsTally();
    for await (const userIds of this.registry.batches()) {
      tally.add(await this.store.snapshot(userIds, now));
    }
    const denied429Today = await this.store.denied429(now);
    const summary = tally.summary(denied429Today, now);
    const interval = readInterval(now);
    return { ...summary, ...interval };
  }

  /** Reads only the IDs and rows of the page. */
  private async unfilteredPage(
    offset: number,
    size: number,
    now: number,
  ): Promise<Matches> {
    const { total, userIds } = await this.registry.page(offset, size);
    if (userIds.length === 0) return { rows: [], total };
    const rows = await this.store.snapshot(userIds, now);
    return { rows, total };
  }

  /** Reads every user, keeping the matches the page shows and their count. */
  private async filteredPage(
    query: UsersQuery,
    offset: number,
    now: number,
  ): Promise<Matches> {
    const matches = rowFilter(query, now);
    const rows: UserRow[] = [];
    let total = 0;
    for await (const userIds of this.registry.batches()) {
      for (const row of await this.store.snapshot(userIds, now)) {
        if (!matches(row)) continue;
        if (total >= offset && rows.length < query.pageSize) rows.push(row);
        total++;
      }
    }
    return { rows, total };
  }
}

function isUnfiltered({ search, status, active }: UsersQuery): boolean {
  return search === '' && status === 'any' && active === 'any';
}

function rowFilter(query: UsersQuery, now: number): RowFilter {
  const search = query.search.toLowerCase();
  const activeSince = activeSinceFor(query.active, now);
  return (row) =>
    row.userId.toLowerCase().includes(search) &&
    (query.status === 'any' || row.status === query.status) &&
    lastRequestAtOrAfter(row, activeSince);
}

/** The earliest last request the filter keeps; null keeps every user. */
function activeSinceFor(
  active: UsersQuery['active'],
  now: number,
): number | null {
  if (active === 'any') return null;
  return now - ACTIVE_PERIOD_MS[active];
}

// A user who never called matches only `any`.
function lastRequestAtOrAfter(row: UserRow, since: number | null): boolean {
  if (since === null) return true;
  if (row.lastRequestAt === null) return false;
  return Date.parse(row.lastRequestAt) >= since;
}

// The read is several transactions, not one snapshot: say when it ran.
function readInterval(startedAtMs: number): ReadInterval {
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt = new Date().toISOString();
  return { startedAt, completedAt };
}
