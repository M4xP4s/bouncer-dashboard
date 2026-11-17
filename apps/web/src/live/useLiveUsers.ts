import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserRow,
} from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import type { Session } from '../api/useSession.ts';
import { isLimitExceeded, isRateUpdate } from '../api/validation.ts';
import { latestRequests } from '../lib/latestRequests.ts';
import { applyRow, applySnapshot, type Rows } from './rows.ts';

export type Connection = 'connecting' | 'live' | 'disconnected';
export interface SnapshotState {
  status: 'pending' | 'loaded' | 'error';
  error: Error | null;
}
interface LiveState {
  rows: Rows;
  liveRecords: ReadonlyMap<string, readonly RequestRecord[]>;
  lastUpdateAt: string | null;
  connection: Connection;
  snapshot: SnapshotState;
  now: number;
  tick: number;
}

const initialState = (): LiveState => ({
  rows: new Map(),
  liveRecords: new Map(),
  lastUpdateAt: null,
  connection: 'connecting',
  snapshot: { status: 'pending', error: null },
  now: clock(),
  tick: 0,
});

/** One session owns one socket and one serialized snapshot queue. Events never fetch. */
export function useLiveUsers(
  session: Session,
  onLimitExceeded?: (event: RateLimitExceededEvent) => void,
) {
  const [state, setState] = useState(initialState);
  const alertRef = useRef(onLimitExceeded);
  const operations = useRef<{
    applyRow: (row: UserRow) => void;
    refresh: () => void;
  } | null>(null);
  useEffect(() => {
    alertRef.current = onLimitExceeded;
  }, [onLimitExceeded]);

  useEffect(() => {
    if (session.signal.aborted) return;
    let held = initialState();
    let disposed = false;
    let running = false;
    let queued = false;
    let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
    let boundaryAt: string | null = null;
    let lastBoundaryAt: string | null = null;
    const socket = openSocket(session.token);
    const active = () => !disposed && !session.signal.aborted;
    const publish = (next: LiveState) => {
      held = next;
      setState(next);
    };

    function scheduleBoundary() {
      if (!active()) return;
      const now = clock();
      const next =
        [...held.rows.values()]
          .map((row) => row.resetAt)
          .filter((at) => Date.parse(at) > now && at !== lastBoundaryAt)
          .sort()[0] ?? null;
      const target = document.visibilityState === 'hidden' ? null : next;
      if (target === boundaryAt) return;
      clearTimeout(boundaryTimer);
      boundaryAt = target;
      if (target === null) return;
      boundaryTimer = setTimeout(
        () => {
          boundaryAt = null;
          lastBoundaryAt = target;
          if (document.visibilityState !== 'hidden') reconcile();
        },
        Date.parse(target) - now,
      );
    }

    async function snapshot() {
      if (!active()) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        const rows = await session.client.users();
        if (!active()) return;
        publish({
          ...held,
          rows: applySnapshot(held.rows, rows),
          lastUpdateAt: new Date(clock()).toISOString(),
          snapshot: { status: 'loaded', error: null },
        });
        scheduleBoundary();
      } catch (error) {
        if (!active()) return;
        publish({
          ...held,
          snapshot: {
            status: 'error',
            error:
              error instanceof Error
                ? error
                : new Error('The snapshot failed.'),
          },
        });
      } finally {
        running = false;
        if (queued && active()) {
          queued = false;
          void snapshot();
        }
      }
    }

    function reconcile() {
      if (!active()) return;
      // Fixture time stands still; the counter still refreshes every open panel.
      publish({ ...held, now: clock(), tick: held.tick + 1 });
      void snapshot();
      scheduleBoundary();
    }

    function applyEvent(
      event: RateUpdateEvent | RateLimitExceededEvent,
    ): boolean {
      if (!active()) return false;
      const rows = applyRow(held.rows, event.row);
      if (rows === held.rows) return false;
      let liveRecords = held.liveRecords;
      if (event.request) {
        const records = latestRequests([
          ...(liveRecords.get(event.row.userId) ?? []),
          event.request,
        ]);
        liveRecords = new Map(liveRecords).set(event.row.userId, records);
      }
      publish({ ...held, rows, liveRecords, lastUpdateAt: event.at });
      scheduleBoundary();
      return true;
    }

    const onUpdate = (event: unknown) => {
      if (isRateUpdate(event)) applyEvent(event);
    };
    const onExceeded = (event: unknown) => {
      if (isLimitExceeded(event) && applyEvent(event))
        alertRef.current?.(event);
    };
    const onConnect = () => {
      if (!active()) return;
      publish({ ...held, connection: 'live' });
      reconcile();
    };
    const onDisconnect = () => {
      if (active()) publish({ ...held, connection: 'disconnected' });
    };
    const onConnectError = () => {
      if (!active()) return;
      if (socket.active) onDisconnect();
      else session.onRefused();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') reconcile();
      else scheduleBoundary();
    };
    operations.current = {
      applyRow: (row) => {
        if (!active()) return;
        const rows = applyRow(held.rows, row);
        if (rows === held.rows) return;
        publish({ ...held, rows });
        scheduleBoundary();
      },
      refresh: reconcile,
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('rate:update', onUpdate);
    socket.on('rate:limit_exceeded', onExceeded);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') reconcile();
    }, 10_000);

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      operations.current = null;
      clearTimeout(boundaryTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('rate:update', onUpdate);
      socket.off('rate:limit_exceeded', onExceeded);
      socket.disconnect();
      session.signal.removeEventListener('abort', cleanup);
    };
    session.signal.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }, [session]);

  const applyResponseRow = useCallback((row: UserRow) => {
    operations.current?.applyRow(row);
  }, []);
  const refresh = useCallback(() => {
    operations.current?.refresh();
  }, []);
  return { ...state, applyRow: applyResponseRow, refresh };
}

export type LiveUsers = ReturnType<typeof useLiveUsers>;
