import { type FocusEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { UserRow } from '@app/contracts';
import type { Rows } from '../../live/rows.ts';

const NO_OPEN_FIELDS: ReadonlySet<string> = new Set();
const NO_USER_IDS: readonly string[] = [];

/**
 * The users of `shown` in their places, each with its newest row: the one of
 * `newest`, or the one `kept` for a user the page has dropped. No row is
 * removed and none added, so no control moves; users new to `newest` wait.
 */
export function rowsWhileHeld(
  shown: readonly UserRow[],
  newest: readonly UserRow[],
  kept: Rows,
): UserRow[] {
  const newestById = new Map(newest.map((row) => [row.userId, row]));
  return shown.map(
    (row) => newestById.get(row.userId) ?? kept.get(row.userId) ?? row,
  );
}

const sameRows = (a: readonly UserRow[], b: readonly UserRow[]) =>
  a.length === b.length && a.every((row, index) => row === b[index]);

/**
 * Keeps the users and their places while the admin points at a row, has focus
 * in one or has a row's field open, so a click cannot land on a row that moved
 * under it. `newest` is the page last read and `kept` the rows the live
 * session holds, which cover a held user the page has dropped. `queryKey`
 * changes with the search, filters, sort and page: a new query is never held.
 */
export function useHeldOrder(newest: UserRow[], kept: Rows, queryKey: string) {
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [openIds, setOpenIds] = useState(NO_OPEN_FIELDS);
  const [shown, setShown] = useState({ queryKey, rows: newest });
  const body = useRef<HTMLTableSectionElement>(null);

  const sameQuery = shown.queryKey === queryKey;
  const held = sameQuery && (pointerIn || focusIn || openIds.size > 0);
  const rows = held ? rowsWhileHeld(shown.rows, newest, kept) : newest;
  // Adjusted while rendering, as React advises for state that follows props:
  // the hold starts from the rows last shown, with no extra paint.
  if (!sameQuery || !sameRows(rows, shown.rows)) setShown({ queryKey, rows });
  // A new query unmounts the rows, so no leave or blur would end the hold.
  if (!sameQuery && (pointerIn || focusIn)) {
    setPointerIn(false);
    setFocusIn(false);
  }
  if (!sameQuery && openIds.size > 0) setOpenIds(NO_OPEN_FIELDS);
  useReleaseLostFocus(focusIn, body, setFocusIn);
  // The same users for the whole hold; a new array only when a value changed.
  const heldUserIds = useMemo(
    () => (held ? shown.rows.map((row) => row.userId) : NO_USER_IDS),
    [held, shown.rows],
  );

  return {
    rows,
    /** The users the live session must keep although the page drops them. */
    heldUserIds,
    bodyProps: {
      ref: body,
      onPointerOver: () => setPointerIn(true),
      onPointerLeave: () => setPointerIn(false),
      // Only keyboard focus holds: a row click also focuses the ID button,
      // and would freeze the order until the admin clicked elsewhere.
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target.matches(':focus-visible')) setFocusIn(true);
      },
      // Tab between two controls of the body keeps the hold without a gap.
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setFocusIn(false);
      },
    },
    onFieldOpened: (userId: string, opened: boolean) =>
      setOpenIds((ids) => withId(ids, userId, opened)),
  };
}

/**
 * Ends a hold by focus once focus has left the body without a blur, as when
 * the focused control is removed. Runs after the rows' effects have refocused.
 * An open field still holds through its own state.
 */
function useReleaseLostFocus(
  focusIn: boolean,
  body: { readonly current: HTMLElement | null },
  setFocusIn: (focusIn: boolean) => void,
) {
  useEffect(() => {
    if (focusIn && !body.current?.contains(document.activeElement)) {
      setFocusIn(false);
    }
  });
}

export type HeldOrder = ReturnType<typeof useHeldOrder>;

function withId(ids: ReadonlySet<string>, userId: string, present: boolean) {
  const next = new Set(ids);
  if (present) next.add(userId);
  else next.delete(userId);
  return next;
}
