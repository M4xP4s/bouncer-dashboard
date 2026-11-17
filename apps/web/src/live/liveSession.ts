import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserRow,
} from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import { listen, type LiveSocket, type SocketEvents } from '../api/socket.ts';
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

type OnState = (state: LiveState) => void;
type OnLimitExceeded = (event: RateLimitExceededEvent) => void;

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
  onState: OnState,
  onLimitExceeded: OnLimitExceeded,
): LiveSession {
  return new SocketSession(session, onState, onLimitExceeded);
}

class SocketSession implements LiveSession {
  private held = initialState();
  private stopped = false;
  private readonly session: Session;
  private readonly onState: OnState;
  private readonly onLimitExceeded: OnLimitExceeded;
  private readonly socket: LiveSocket;
  private readonly unlisten: () => void;
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly alarm = resetAlarm(() => this.refreshIfVisible());
  private readonly loadSnapshot = oneAtATime(() => this.fetchSnapshot());

  constructor(
    session: Session,
    onState: OnState,
    onLimitExceeded: OnLimitExceeded,
  ) {
    this.session = session;
    this.onState = onState;
    this.onLimitExceeded = onLimitExceeded;
    this.socket = openSocket(session.token);
    this.unlisten = listen(this.socket, this.socketHandlers());
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.interval = setInterval(
      () => this.refreshIfVisible(),
      SNAPSHOT_INTERVAL_MS,
    );
    session.signal.addEventListener('abort', this.stop, { once: true });
  }

  applyRow(row: UserRow): void {
    const rows = this.rowsWith(row);
    if (!rows) return;
    this.publish({ rows });
    this.alarm.aim(rows);
  }

  refresh(): void {
    if (!this.active()) return;
    // Fixture time stands still, so the tick is what makes panels reload.
    this.publish({ now: clock(), tick: this.held.tick + 1 });
    this.loadSnapshot();
    this.alarm.aim(this.held.rows);
  }

  // Arrow fields: both are event listeners, called without a receiver.
  readonly stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.alarm.cancel();
    clearInterval(this.interval);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.unlisten();
    this.socket.disconnect();
    this.session.signal.removeEventListener('abort', this.stop);
  };

  // Hidden: aiming again cancels the alarm, as a hidden page waits for none.
  private readonly onVisibilityChange = (): void => {
    if (pageVisible()) this.refresh();
    else this.alarm.aim(this.held.rows);
  };

  private active(): boolean {
    return !this.stopped && !this.session.signal.aborted;
  }

  private publish(change: Partial<LiveState>): void {
    this.held = { ...this.held, ...change };
    this.onState(this.held);
  }

  private refreshIfVisible(): void {
    if (pageVisible()) this.refresh();
  }

  private async fetchSnapshot(): Promise<void> {
    if (!this.active()) return;
    try {
      const rows = await this.session.client.users();
      if (!this.active()) return;
      this.publish({
        rows: applySnapshot(this.held.rows, rows),
        lastUpdateAt: new Date(clock()).toISOString(),
        snapshot: { status: 'loaded', error: null },
      });
      this.alarm.aim(this.held.rows);
    } catch (thrown) {
      if (!this.active()) return;
      const error = toError(thrown, 'The snapshot failed.');
      this.publish({ snapshot: { status: 'error', error } });
    }
  }

  /** The rows with `row` applied, or null when the held row is not older. */
  private rowsWith(row: UserRow): Rows | null {
    if (!this.active()) return null;
    const rows = applyRow(this.held.rows, row);
    return rows === this.held.rows ? null : rows;
  }

  /** Returns false when the event is dropped whole: its row is not newer. */
  private applyEvent(event: RateUpdateEvent | RateLimitExceededEvent): boolean {
    const rows = this.rowsWith(event.row);
    if (!rows) return false;
    const { userId } = event.row;
    const liveRecords = withRequest(
      this.held.liveRecords,
      userId,
      event.request,
    );
    this.publish({ rows, liveRecords, lastUpdateAt: event.at });
    this.alarm.aim(rows);
    return true;
  }

  private showDisconnected(): void {
    if (this.active()) this.publish({ connection: 'disconnected' });
  }

  private socketHandlers(): SocketEvents {
    return {
      connect: () => {
        if (!this.active()) return;
        this.publish({ connection: 'live' });
        this.refresh();
      },
      disconnect: () => this.showDisconnected(),
      // Socket.IO keeps retrying a network failure; a refused handshake is final.
      connect_error: () => {
        if (!this.active()) return;
        if (this.socket.active) this.showDisconnected();
        else this.session.onRefused();
      },
      // A payload that fails its shape check is ignored whole.
      'rate:update': (event: unknown) => {
        if (isRateUpdate(event)) this.applyEvent(event);
      },
      'rate:limit_exceeded': (event: unknown) => {
        if (isLimitExceeded(event) && this.applyEvent(event)) {
          this.onLimitExceeded(event);
        }
      },
    };
  }
}
