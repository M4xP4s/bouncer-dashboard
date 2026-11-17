import { useCallback, useEffect, useRef, useState } from 'react';
import type { RateLimitExceededEvent, UserRow } from '@app/contracts';
import type { Session } from '../api/useSession.ts';
import {
  initialState,
  startLiveSession,
  type LiveSession,
} from './liveSession.ts';

export type { Connection, SnapshotState } from './liveSession.ts';

/** The live state of one session, and the two ways a component changes it. */
export function useLiveUsers(
  session: Session,
  onLimitExceeded?: (event: RateLimitExceededEvent) => void,
) {
  const [state, setState] = useState(initialState);
  const live = useRef<LiveSession | null>(null);
  // A ref, so a new callback does not reopen the socket.
  const alertRef = useRef(onLimitExceeded);
  useEffect(() => {
    alertRef.current = onLimitExceeded;
  }, [onLimitExceeded]);

  useEffect(() => {
    if (session.signal.aborted) return;
    const started = startLiveSession(session, setState, (event) =>
      alertRef.current?.(event),
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
  const refresh = useCallback(() => {
    live.current?.refresh();
  }, []);
  return { ...state, applyRow, refresh };
}

export type LiveUsers = ReturnType<typeof useLiveUsers>;
