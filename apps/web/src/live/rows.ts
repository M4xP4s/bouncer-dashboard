import type { UserRow, UsersPage } from '@app/contracts';

/** The rows the dashboard holds, one per user. Never changed in place. */
export type Rows = ReadonlyMap<string, UserRow>;

// The window comes first: a new hour resets usage without raising the
// version. ISO 8601 UTC timestamps sort as text in the order of time.
export function isNewer(candidate: UserRow, held: UserRow): boolean {
  if (candidate.resetAt !== held.resetAt) {
    return candidate.resetAt > held.resetAt;
  }
  return candidate.version > held.version;
}

function sameRow(a: UserRow, b: UserRow): boolean {
  const fields = Object.keys(a) as (keyof UserRow)[];
  return fields.every((field) => a[field] === b[field]);
}

/**
 * A row from an event or a response replaces the held one only if newer.
 * Otherwise the same map is returned, so nothing re-renders.
 */
export function applyRow(rows: Rows, row: UserRow): Rows {
  const held = rows.get(row.userId);
  if (held && !isNewer(row, held)) return rows;
  return new Map(rows).set(row.userId, row);
}

// An equal version may still differ: a suspension that ended or a rejected
// request that was removed changes the row without a new version.
function snapshotReplaces(row: UserRow, held: UserRow | undefined): boolean {
  if (!held) return true;
  if (isNewer(held, row)) return false;
  return !sameRow(held, row);
}

/** Returns the same map when the snapshot changes nothing. */
export function applySnapshot(rows: Rows, snapshot: UserRow[]): Rows {
  const changed = snapshot.filter((row) =>
    snapshotReplaces(row, rows.get(row.userId)),
  );
  if (changed.length === 0) return rows;

  const next = new Map(rows);
  for (const row of changed) next.set(row.userId, row);
  return next;
}

/** When the user's suspension ends, or null when throttling applies now. */
export function suspensionEnd(row: UserRow, now: number): string | null {
  const until = row.suspendedUntil;
  return until !== null && Date.parse(until) > now ? until : null;
}

/** The page's users in its order, each with the newest held row. */
export function pageRows(page: UsersPage | null, rows: Rows): UserRow[] {
  if (!page) return [];
  return page.rows.map((row) => rows.get(row.userId) ?? row);
}
