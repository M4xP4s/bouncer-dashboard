import type { Analytics, ReadInterval, TopUser, UserRow } from '@app/contracts';
import { utcDay } from '../rate-limit/keys.js';

const TOP_USER_COUNT = 5;

type AnalyticsSummary = Omit<Analytics, keyof ReadInterval>;

/** Adds rows up a batch at a time; holds counts and five users, whatever the population. */
export class AnalyticsTally {
  private totalUsers = 0;
  private activeUsers = 0;
  private nearLimitUsers = 0;
  private topUsers: TopUser[] = [];

  add(rows: readonly UserRow[]): void {
    this.totalUsers += rows.length;
    for (const row of rows) {
      if (row.used === 0) continue;
      this.activeUsers++;
      if (row.status !== 'OK') this.nearLimitUsers++;
      this.rank(row);
    }
  }

  summary(denied429Today: number, now: number): AnalyticsSummary {
    const nearLimitPercent = percentOf(this.nearLimitUsers, this.activeUsers);
    const day = utcDay(now);
    return {
      totalUsers: this.totalUsers,
      activeUsers: this.activeUsers,
      nearLimitPercent,
      denied429Today,
      day,
      topUsers: this.topUsers,
    };
  }

  private rank({ userId, used, total }: UserRow): void {
    this.topUsers.push({ userId, used, total });
    this.topUsers.sort(byUsageThenId);
    if (this.topUsers.length > TOP_USER_COUNT) this.topUsers.pop();
  }
}

function byUsageThenId(a: TopUser, b: TopUser): number {
  if (a.used !== b.used) return b.used - a.used;
  return a.userId < b.userId ? -1 : 1;
}

function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part * 100) / whole);
}
