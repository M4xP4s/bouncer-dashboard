import { buildRow, type RowReplies } from './row.js';

const now = Date.parse('2026-11-16T10:42:00.000Z');

/** The five replies of the row read, with defaults for a user at `used`. */
const replies = (
  used: number,
  {
    limit = null,
    extra = null,
    suspend = null,
    user = {},
  }: {
    limit?: string | null;
    extra?: string | null;
    suspend?: string | null;
    user?: Record<string, string>;
  } = {},
): RowReplies => [used, limit, extra, suspend, user];

describe('buildRow', () => {
  it('describes a user who never called', () => {
    expect(buildRow('user-01', replies(0), now)).toEqual({
      userId: 'user-01',
      used: 0,
      limit: 100,
      extra: 0,
      total: 100,
      remaining: 100,
      status: 'OK',
      resetAt: '2026-11-16T11:00:00.000Z',
      lastRequestAt: null,
      lastResetAt: '2026-11-16T10:00:00.000Z',
      suspendedUntil: null,
      version: 0,
    });
  });

  it('adds an extra grant to the total, not to the limit', () => {
    const row = buildRow('user-01', replies(30, { extra: '20' }), now);

    expect(row).toMatchObject({
      limit: 100,
      extra: 20,
      total: 120,
      remaining: 90,
    });
  });

  it.each([
    [89, 100, 'OK'],
    [90, 100, 'Warning'],
    [99, 100, 'Warning'],
    [100, 100, 'Exceeded'],
    // A custom limit whose 90% is not a whole number.
    [9, 11, 'OK'],
    [10, 11, 'Warning'],
    [11, 11, 'Exceeded'],
  ])('%i of %i is %s', (used, limit, status) => {
    const row = buildRow('user-01', replies(used, { limit: `${limit}` }), now);

    expect(row.status).toBe(status);
    expect(row.remaining).toBe(limit - used);
  });

  it('keeps real usage above a lowered limit and clamps remaining at 0', () => {
    const row = buildRow('user-01', replies(80, { limit: '50' }), now);

    expect(row).toMatchObject({ used: 80, total: 50, remaining: 0 });
    expect(row.status).toBe('Exceeded');
  });

  it('reads the version and the last request time from the user hash', () => {
    const lastRequestAt = Date.parse('2026-11-16T10:41:59.000Z');
    const user = { v: '7', lastRequestAt: `${lastRequestAt}` };

    expect(buildRow('user-01', replies(7, { user }), now)).toMatchObject({
      version: 7,
      lastRequestAt: '2026-11-16T10:41:59.000Z',
    });
  });

  it('reports a manual reset in this window as the last reset', () => {
    const user = {
      lastManualResetAt: `${Date.parse('2026-11-16T10:30:00.000Z')}`,
    };

    expect(buildRow('user-01', replies(0, { user }), now).lastResetAt).toBe(
      '2026-11-16T10:30:00.000Z',
    );
  });

  it('reports the window start when the manual reset is older', () => {
    const user = {
      lastManualResetAt: `${Date.parse('2026-11-16T09:30:00.000Z')}`,
    };

    expect(buildRow('user-01', replies(0, { user }), now).lastResetAt).toBe(
      '2026-11-16T10:00:00.000Z',
    );
  });

  it('shows a suspension that ends in the future', () => {
    const suspend = `${Date.parse('2026-11-16T10:50:00.000Z')}`;

    expect(
      buildRow('user-01', replies(0, { suspend }), now).suspendedUntil,
    ).toBe('2026-11-16T10:50:00.000Z');
  });

  it('does not show a suspension whose end has been reached', () => {
    // Redis removes the key a moment later; the stored time decides.
    const suspend = `${now}`;

    expect(
      buildRow('user-01', replies(0, { suspend }), now).suspendedUntil,
    ).toBeNull();
  });
});
