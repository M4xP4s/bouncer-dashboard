import type { UserRow } from '@app/contracts';
import { buildRow } from '../rate-limit/row.js';
import { AnalyticsTally } from './analytics.js';

const now = Date.parse('2026-11-16T10:00:00Z');
const row = (id: string, used: number) =>
  buildRow(id, [used, null, null, null, {}], now);

function summaryOf(...batches: UserRow[][]) {
  const tally = new AnalyticsTally();
  for (const rows of batches) tally.add(rows);
  return tally.summary(0, now);
}

describe('AnalyticsTally', () => {
  it('returns zero near-limit percent with no active users', () => {
    expect(summaryOf([row('idle', 0)])).toMatchObject({
      totalUsers: 1,
      activeUsers: 0,
      nearLimitPercent: 0,
      topUsers: [],
    });
  });

  it('ranks up to five active users by usage, equal usage by user ID', () => {
    const result = summaryOf([
      row('z', 90),
      row('b', 100),
      row('a', 100),
      row('e', 1),
      row('d', 1),
      row('c', 1),
      row('idle', 0),
    ]);
    expect(result.topUsers.map((user) => user.userId)).toEqual([
      'a',
      'b',
      'z',
      'c',
      'd',
    ]);
  });

  it('adds rows given in batches as if they came at once', () => {
    const rows = [row('a', 90), row('b', 5), row('c', 0), row('d', 100)];

    expect(
      summaryOf(rows.slice(0, 1), rows.slice(1, 3), rows.slice(3)),
    ).toEqual(summaryOf(rows));
    expect(summaryOf(rows)).toMatchObject({
      totalUsers: 4,
      activeUsers: 3,
      nearLimitPercent: 67,
    });
  });

  it('reports the supplied rejection count and the UTC day', () => {
    expect(new AnalyticsTally().summary(7, now)).toMatchObject({
      denied429Today: 7,
      day: '2026-11-16',
    });
  });

  it('counts Warning and Exceeded users and rounds two of three to 67 percent', () => {
    expect(
      summaryOf([row('warning', 90), row('exceeded', 100), row('ok', 1)]),
    ).toMatchObject({ activeUsers: 3, nearLimitPercent: 67 });
  });

  it('uses authoritative row status rather than recalculating near-limit policy', () => {
    const marked: UserRow = { ...row('marked', 1), status: 'Warning' };
    const clear: UserRow = { ...row('clear', 100), status: 'OK' };
    expect(summaryOf([marked]).nearLimitPercent).toBe(100);
    expect(summaryOf([clear]).nearLimitPercent).toBe(0);
  });

  it('counts every user at its status, idle ones as OK, adding up to the total', () => {
    const result = summaryOf([
      row('idle', 0),
      row('active', 1),
      row('warning', 90),
      row('exceeded', 100),
      row('over', 130),
    ]);

    expect(result.statusCounts).toEqual({ OK: 2, Warning: 1, Exceeded: 2 });
    expect(result.totalUsers).toBe(5);
  });
});
