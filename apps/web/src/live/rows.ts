import type { UserRow } from '@app/contracts';

/** The rows the dashboard holds, one per user. Never changed in place. */
export type Rows = ReadonlyMap<string, UserRow>;

/**
 * Whether `candidate` describes a later state of the same user than `held`.
 *
 * The window comes first: a new hour resets usage without changing the
 * version, so a row of a later window is newer whatever its version. Within
 * one window the higher version is newer. Both timestamps are ISO 8601 in
 * UTC, which sort as text in the order of time.
 */
export function isNewer(candidate: UserRow, held: UserRow): boolean {
  if (candidate.resetAt !== held.resetAt)
    return candidate.resetAt > held.resetAt;
  return candidate.version > held.version;
}

/**
 * Applies a row from an event. Events can arrive out of order, so a row
 * replaces the held one only if it is newer; otherwise the same map is
 * returned and nothing re-renders.
 */
export function applyRow(rows: Rows, row: UserRow): Rows {
  const held = rows.get(row.userId);
  if (held && !isNewer(row, held)) return rows;
  return new Map(rows).set(row.userId, row);
}

/** Equal versions may differ after time-based expiry or rejection cleanup. */
export function applySnapshot(rows: Rows, snapshot: UserRow[]): Rows {
  let next: Map<string, UserRow> | null = null;
  for (const row of snapshot) {
    const held = (next ?? rows).get(row.userId);
    if (held === row || (held && isNewer(held, row))) continue;
    if (
      held &&
      Object.entries(held).every(
        ([key, value]) => row[key as keyof UserRow] === value,
      )
    )
      continue;
    next ??= new Map(rows);
    next.set(row.userId, row);
  }
  return next ?? rows;
}
