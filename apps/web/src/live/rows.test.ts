import { expect, it } from 'vitest';
import type { UserRow } from '@app/contracts';
import { users } from '../fixtures/index.ts';
import { applyRow, applySnapshot, type Rows } from './rows.ts';

const held: UserRow = { ...users[0], version: 12 };
const rows: Rows = new Map([[held.userId, held]]);
const nextHour = '2026-11-16T12:00:00.000Z';

it('adds a user that is not held yet', () => {
  const other = users[1];

  expect(applyRow(rows, other).get(other.userId)).toBe(other);
});

it('replaces a row with one of a higher version', () => {
  const newer = { ...held, version: 13, used: held.used + 1 };

  expect(applyRow(rows, newer).get(held.userId)).toBe(newer);
});

it.each([
  ['a lower', 11],
  ['an equal', 12],
])('ignores a row of %s version', (_case, version) => {
  // Events can arrive out of order; an older one must not undo a newer one.
  const stale = { ...held, version, used: 0 };

  expect(applyRow(rows, stale)).toBe(rows);
});

it('replaces a row with one of a later window, even at the same version', () => {
  // A new hour resets usage without changing the version.
  const newHour = { ...held, resetAt: nextHour, used: 0 };

  expect(applyRow(rows, newHour).get(held.userId)).toBe(newHour);
});

it('ignores a row of an earlier window, whatever its version', () => {
  const inNewHour: Rows = new Map([
    [held.userId, { ...held, resetAt: nextHour, used: 0 }],
  ]);
  const lateFromOldHour = { ...held, version: 99 };

  expect(applyRow(inNewHour, lateFromOldHour)).toBe(inNewHour);
});

it('lets only a snapshot repair an equal-version row', () => {
  const repaired = {
    ...held,
    used: held.used - 1,
    remaining: held.remaining + 1,
  };
  expect(applySnapshot(rows, [repaired]).get(held.userId)).toBe(repaired);
  // Detail/admin responses use the same strict rule as events.
  expect(applyRow(rows, repaired)).toBe(rows);
});

it('preserves a newer event and map identity when a stale snapshot changes nothing', () => {
  expect(applySnapshot(rows, [{ ...held, version: 11 }])).toBe(rows);
  expect(applySnapshot(rows, [held])).toBe(rows);
  expect(applySnapshot(rows, [{ ...held }])).toBe(rows);
  expect(applySnapshot(rows, [])).toBe(rows);
});

it('ignores the previous hour after a new-hour snapshot even with a higher version', () => {
  const updated = applySnapshot(rows, [
    { ...held, resetAt: nextHour, used: 0 },
  ]);
  expect(applyRow(updated, { ...held, version: 1000 })).toBe(updated);
});
