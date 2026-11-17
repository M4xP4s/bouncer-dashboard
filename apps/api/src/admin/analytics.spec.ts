import { buildRow } from '../rate-limit/row.js';
import { analytics } from './analytics.js';

const now = Date.parse('2026-11-16T10:00:00Z');
const row = (id: string, used: number) =>
  buildRow(id, [used, null, null, null, {}], now);

describe('analytics', () => {
  it('returns zero near-limit percent with no active users', () => {
    expect(analytics([row('idle', 0)], 0, now)).toMatchObject({
      activeUsers: 0,
      nearLimitPercent: 0,
      topUsers: [],
      day: '2026-11-16',
    });
  });
  it('counts exceeded users and ranks only active users by usage, ties in input order', () => {
    const result = analytics(
      [
        row('z', 90),
        row('b', 100),
        row('a', 100),
        row('c', 1),
        row('d', 1),
        row('e', 1),
        row('idle', 0),
      ],
      7,
      now,
    );
    expect(result.nearLimitPercent).toBe(50);
    expect(result.denied429Today).toBe(7);
    expect(result.topUsers.map((user) => user.userId)).toEqual([
      'b',
      'a',
      'z',
      'c',
      'd',
    ]);
  });
  it('rounds two of three active users near their limit to 67 percent', () => {
    expect(
      analytics(
        [row('warning', 90), row('exceeded', 100), row('ok', 1)],
        0,
        now,
      ),
    ).toMatchObject({ activeUsers: 3, nearLimitPercent: 67 });
  });
  it('uses authoritative row status rather than recalculating near-limit policy', () => {
    const marked = { ...row('marked', 1), status: 'Warning' as const };
    const clear = { ...row('clear', 100), status: 'OK' as const };
    expect(analytics([marked, clear], 0, now).nearLimitPercent).toBe(50);
    expect(analytics([marked], 0, now).nearLimitPercent).toBe(100);
    expect(analytics([clear], 0, now).nearLimitPercent).toBe(0);
  });
});
