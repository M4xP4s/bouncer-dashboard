import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserRow,
} from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import { listen } from '../api/socket.ts';
import type { Session } from '../api/useSession.ts';
import { isLimitExceeded, isRateUpdate } from '../api/validation.ts';
import { oneAtATime, toError } from '../lib/async.ts';
import { latestRequests } from '../lib/latestRequests.ts';
import { SECOND_MS } from '../lib/time.ts';
import { applyRow, applySnapshot, type Rows } from './rows.ts';

export type Connection = 'connecting' | 'live' | 'disconnected';

export interface SnapshotState {
  status: 'pending' | 'loaded' | 'error';
  error: Error | null;
}

type LiveRecords = ReadonlyMap<string, readonly RequestRecord[]>;

export interface LiveState {
  rows: Rows;
  /** Per user, the requests that events carried since the page opened. */
  liveRecords: LiveRecords;
  lastUpdateAt: string | null;
  connection: Connection;
  snapshot: SnapshotState;
  /** The clock at the last reconciliation. */
  now: number;
  /** Rises with every reconciliation; open panels reload when it changes. */
  tick: number;
}

export interface LiveSession {
  /** Applies the row of an HTTP response under the same ordering as events. */
  applyRow(row: UserRow): void;
  refresh(): void;
  stop(): void;
}

const SNAPSHOT_INTERVAL_MS = 10 * SECOND_MS;

export const initialState = (): LiveState => ({
  rows: new Map(),
  liveRecords: new Map(),
  lastUpdateAt: null,
  connection: 'connecting',
  snapshot: { status: 'pending', error: null },
  now: clock(),
  tick: 0,
});

const pageVisible = () => document.visibilityState !== 'hidden';

function earliestReset(
  rows: Rows,
  after: number,
  except: string | null,
): string | null {
  const upcoming = [...rows.values()]
    .map((row) => row.resetAt)
    .filter((resetAt) => Date.parse(resetAt) > after && resetAt !== except);
  return upcoming.sort()[0] ?? null;
}

/** Calls `onReset` when the earliest reset time it was aimed at arrives. */
function resetAlarm(onReset: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aimedAt: string | null = null;
  let lastFiredAt: string | null = null;

  // A hidden page waits for no reset; it reconciles when it is shown again.
  function aim(rows: Rows): void {
    const now = clock();
    const target = pageVisible() ? earliestReset(rows, now, lastFiredAt) : null;
    if (target === aimedAt) return;

    clearTimeout(timer);
    aimedAt = target;
    if (target === null) return;
    timer = setTimeout(
      () => {
        aimedAt = null;
        lastFiredAt = target;
        onReset();
      },
      Date.parse(target) - now,
    );
  }

  return { aim, cancel: () => clearTimeout(timer) };
}

function withRequest(
  records: LiveRecords,
  userId: string,
  request: RequestRecord | null,
): LiveRecords {
  if (!request) return records;
  const requests = latestRequests([...(records.get(userId) ?? []), request]);
  return new Map(records).set(userId, requests);
}

/**
 * Owns one socket, its timers and the snapshot queue until `stop` is called
 * or the session ends. An event never causes a request.
 */
export function startLiveSession(
  session: Session,
  onState: (state: LiveState) => void,
  onLimitExceeded: (event: RateLimitExceededEvent) => void,
): LiveSession {
  let held = initialState();
  let stopped = false;
  const socket = openSocket(session.token);
  const active = () => !stopped && !session.signal.aborted;

  function publish(change: Partial<LiveState>): void {
    held = { ...held, ...change };
    onState(held);
  }

  const alarm = resetAlarm(() => {
    if (pageVisible()) reconcile();
  });

  const loadSnapshot = oneAtATime(async () => {
    if (!active()) return;
    try {
      const rows = await session.client.users();
      if (!active()) return;
      publish({
        rows: applySnapshot(held.rows, rows),
        lastUpdateAt: new Date(clock()).toISOString(),
        snapshot: { status: 'loaded', error: null },
      });
      alarm.aim(held.rows);
    } catch (thrown) {
      if (!active()) return;
      const error = toError(thrown, 'The snapshot failed.');
      publish({ snapshot: { status: 'error', error } });
    }
  });

  function reconcile(): void {
    if (!active()) return;
    // Fixture time stands still, so the tick is what makes panels reload.
    publish({ now: clock(), tick: held.tick + 1 });
    loadSnapshot();
    alarm.aim(held.rows);
  }

  /** The rows with `row` applied, or null when the held row is not older. */
  function rowsWith(row: UserRow): Rows | null {
    if (!active()) return null;
    const rows = applyRow(held.rows, row);
    return rows === held.rows ? null : rows;
  }

  function applyResponseRow(row: UserRow): void {
    const rows = rowsWith(row);
    if (!rows) return;
    publish({ rows });
    alarm.aim(rows);
  }

  /** Returns false when the event is dropped whole: its row is not newer. */
  function applyEvent(event: RateUpdateEvent | RateLimitExceededEvent) {
    const rows = rowsWith(event.row);
    if (!rows) return false;
    const { userId } = event.row;
    const liveRecords = withRequest(held.liveRecords, userId, event.request);
    publish({ rows, liveRecords, lastUpdateAt: event.at });
    alarm.aim(rows);
    return true;
  }

  function showDisconnected(): void {
    if (active()) publish({ connection: 'disconnected' });
  }

  const unlisten = listen(socket, {
    connect: () => {
      if (!active()) return;
      publish({ connection: 'live' });
      reconcile();
    },
    disconnect: showDisconnected,
    // Socket.IO keeps retrying a network failure; a refused handshake is final.
    connect_error: () => {
      if (!active()) return;
      if (socket.active) showDisconnected();
      else session.onRefused();
    },
    // A payload that fails its shape check is ignored whole.
    'rate:update': (event: unknown) => {
      if (isRateUpdate(event)) applyEvent(event);
    },
    'rate:limit_exceeded': (event: unknown) => {
      if (isLimitExceeded(event) && applyEvent(event)) onLimitExceeded(event);
    },
  });

  function onVisibilityChange(): void {
    if (pageVisible()) reconcile();
    else if (active()) alarm.aim(held.rows);
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  const interval = setInterval(() => {
    if (pageVisible()) reconcile();
  }, SNAPSHOT_INTERVAL_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    alarm.cancel();
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    unlisten();
    socket.disconnect();
    session.signal.removeEventListener('abort', stop);
  }
  session.signal.addEventListener('abort', stop, { once: true });

  return { applyRow: applyResponseRow, refresh: reconcile, stop };
}
