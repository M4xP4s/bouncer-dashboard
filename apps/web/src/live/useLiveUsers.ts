import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RateLimitExceededEvent,
  UserRow,
  UsersQuery,
} from '@app/contracts';
import type { Session } from '../api/useSession.ts';
import {
  initialState,
  startLiveSession,
  type LiveSession,
} from './liveSession.ts';

export type { Connection, SnapshotState } from './liveSession.ts';

/** The live state of one session, and the ways a component changes it. */
export function useLiveUsers(
  session: Session,
  query: UsersQuery,
  selected: string | null,
  onLimitExceeded?: (event: RateLimitExceededEvent) => void,
) {
  const [state, setState] = useState(initialState);
  const live = useRef<LiveSession | null>(null);
  // A ref, so a new page or selection keeps the socket.
  const viewRef = useRef({ query, selected });
  useEffect(() => {
    viewRef.current = { query, selected };
    live.current?.show(viewRef.current);
  }, [query, selected]);
  // A ref, so a new callback does not reopen the socket.
  const alertRef = useRef(onLimitExceeded);
  useEffect(() => {
    alertRef.current = onLimitExceeded;
  }, [onLimitExceeded]);

  useEffect(() => {
    if (session.signal.aborted) return;
    const started = startLiveSession(
      session,
      viewRef.current,
      setState,
      (event) => alertRef.current?.(event),
    );
    live.current = started;
    return () => {
      live.current = null;
      started.stop();
    };
  }, [session]);

  const applyRow = useCallback((row: UserRow) => {
    live.current?.applyRow(row);
  }, []);
  const applyDetailRow = useCallback((row: UserRow) => {
    live.current?.applyDetailRow(row);
  }, []);
  const keep = useCallback((userIds: readonly string[]) => {
    live.current?.keep(userIds);
  }, []);
  const refresh = useCallback(() => {
    live.current?.refresh();
  }, []);
  return { ...state, applyRow, applyDetailRow, keep, refresh };
}

export type LiveUsers = ReturnType<typeof useLiveUsers>;
