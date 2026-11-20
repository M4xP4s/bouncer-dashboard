import type {
  RateLimitExceededEvent,
  RateUpdateEvent,
  RequestRecord,
  UserRow,
  UsersPage,
  UsersQuery,
} from '@app/contracts';
import { clock, openSocket } from '../api/index.ts';
import { listen, type LiveSocket, type SocketEvents } from '../api/socket.ts';
import type { Session } from '../api/useSession.ts';
import { sameQuery } from '../api/usersQuery.ts';
import { isLimitExceeded, isRateUpdate } from '../api/validation.ts';
import { oneAtATime, toError } from '../lib/async.ts';
import { latestRequests } from '../lib/latestRequests.ts';
import { SECOND_MS } from '../lib/time.ts';
import { applyRow, applySnapshot, type Rows } from './rows.ts';

export type Connection = 'connecting' | 'live' | 'disconnected';

export type SnapshotState =
  | { status: 'pending' | 'loaded'; error: null }
  | { status: 'error'; error: Error };

type LiveRecords = ReadonlyMap<string, readonly RequestRecord[]>;

export interface LiveState {
  /** The rows of the page on screen, the selected user and the kept users. */
  rows: Rows;
  /** Null while the read of a new page or filter runs. */
  page: UsersPage | null;
  /** The requests that events carried for the selected user. */
  liveRecords: LiveRecords;
  lastUpdateAt: string | null;
  connection: Connection;
  snapshot: SnapshotState;
  /** The clock at the last reconciliation. */
  now: number;
  /** Rises with every reconciliation; open panels reload when it changes. */
  tick: number;
}

/** The page asked for and the user whose detail is open. */
export interface LiveView {
  query: UsersQuery;
  selected: string | null;
}

export interface LiveSession {
  /** Applies the row of an HTTP response under the same ordering as events. */
  applyRow(row: UserRow): void;
  /** Applies the row of a held user's detail response. */
  applyDetailRow(row: UserRow): void;
  /** The users whose rows stay held once the page drops them; none ends it. */
  keep(userIds: readonly string[]): void;
  show(view: LiveView): void;
  refresh(): void;
  stop(): void;
}

type OnState = (state: LiveState) => void;
type OnLimitExceeded = (event: RateLimitExceededEvent) => void;
type LiveEvent = RateUpdateEvent | RateLimitExceededEvent;

const SNAPSHOT_INTERVAL_MS = 10 * SECOND_MS;
const PENDING_USERS_MAX = 100;
const NO_USER_IDS: ReadonlySet<string> = new Set();

export const initialState = (): LiveState => ({
  rows: new Map(),
  page: null,
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

/**
 * Keeps the rows that events carry while a page not yet known is read, the
 * newest per user, to apply over the response. A user past the cap is
 * dropped: their next event or the next reconciliation repairs the row.
 */
class EventBuffer {
  private rows: Rows | null = null;

  open(): void {
    this.rows = new Map();
  }

  add(row: UserRow): void {
    if (!this.rows) return;
    const buffered = applyRow(this.rows, row);
    if (buffered.size <= PENDING_USERS_MAX) this.rows = buffered;
  }

  close(): Rows {
    const taken = this.rows ?? new Map();
    this.rows = null;
    return taken;
  }
}

/** The entries of the given users only; the same map when none is dropped. */
function onlyUsers<T>(
  entries: ReadonlyMap<string, T>,
  userIds: ReadonlySet<string>,
): ReadonlyMap<string, T> {
  const kept = [...entries].filter(([userId]) => userIds.has(userId));
  return kept.length === entries.size ? entries : new Map(kept);
}

function applyRowsOf(
  rows: Rows,
  candidates: Rows,
  userIds: ReadonlySet<string>,
): Rows {
  let applied = rows;
  for (const row of candidates.values()) {
    if (userIds.has(row.userId)) applied = applyRow(applied, row);
  }
  return applied;
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
  initialView: LiveView,
  onState: OnState,
  onLimitExceeded: OnLimitExceeded,
): LiveSession {
  return new SocketSession(session, initialView, onState, onLimitExceeded);
}

class SocketSession implements LiveSession {
  private held = initialState();
  private stopped = false;
  private view: LiveView;
  // The users the table holds in place: at most the page they were held from.
  private kept = NO_USER_IDS;
  // Rises with every new page or filter; a read of an older one is dropped.
  private generation = 0;
  private pageRead: AbortController | null = null;
  private readonly pending = new EventBuffer();
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
    initialView: LiveView,
    onState: OnState,
    onLimitExceeded: OnLimitExceeded,
  ) {
    this.session = session;
    this.view = initialView;
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
    if (this.isHeld(row.userId)) this.publishRows(this.rowsWith(row));
  }

  // No page read covers a held user who is off the page, so the detail
  // response repairs an equal row the way a snapshot does.
  applyDetailRow(row: UserRow): void {
    if (!this.active()) return;
    if (this.isOnPage(row.userId) || !this.isHeld(row.userId)) {
      this.applyRow(row);
      return;
    }
    const rows = applySnapshot(this.held.rows, [row]);
    if (rows !== this.held.rows) this.publishRows(rows);
  }

  keep(userIds: readonly string[]): void {
    if (!this.active()) return;
    this.kept = new Set(userIds);
    // Letting go drops the rows the page no longer lists.
    const { rows } = this.heldFor(this.held.page);
    if (rows !== this.held.rows) this.publishRows(rows);
  }

  show(next: LiveView): void {
    if (!this.active()) return;
    const queryChanged = !sameQuery(this.view.query, next.query);
    const selectionChanged = next.selected !== this.view.selected;
    this.view = next;
    if (queryChanged) {
      this.startNewPage();
      return;
    }
    if (selectionChanged) this.publish(this.heldFor(this.held.page));
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
    this.pageRead?.abort();
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

  private isCurrent(readGeneration: number): boolean {
    return this.active() && readGeneration === this.generation;
  }

  private publish(change: Partial<LiveState>): void {
    this.held = { ...this.held, ...change };
    this.onState(this.held);
  }

  private publishRows(rows: Rows | null): void {
    if (!rows) return;
    this.publish({ rows });
    this.alarm.aim(rows);
  }

  private refreshIfVisible(): void {
    if (pageVisible()) this.refresh();
  }

  /** The users whose rows are held: on `page`, selected or kept. */
  private heldUserIds(page: UsersPage | null): ReadonlySet<string> {
    const userIds = new Set(page?.rows.map((row) => row.userId));
    if (this.view.selected !== null) userIds.add(this.view.selected);
    for (const userId of this.kept) userIds.add(userId);
    return userIds;
  }

  private isHeld(userId: string): boolean {
    return this.held.rows.has(userId) || userId === this.view.selected;
  }

  private isOnPage(userId: string): boolean {
    return this.held.page?.rows.some((row) => row.userId === userId) ?? false;
  }

  private heldFor(page: UsersPage | null) {
    const { selected } = this.view;
    const selectedIds = new Set(selected === null ? [] : [selected]);
    const rows = onlyUsers(this.held.rows, this.heldUserIds(page));
    const liveRecords = onlyUsers(this.held.liveRecords, selectedIds);
    return { rows, liveRecords };
  }

  // A new page or filter keeps the socket and cancels the read in flight.
  private startNewPage(): void {
    this.generation += 1;
    this.pageRead?.abort();
    // A hold never outlasts its page, whichever effect of the table runs first.
    this.kept = NO_USER_IDS;
    this.publish({
      ...this.heldFor(null),
      page: null,
      snapshot: { status: 'pending', error: null },
    });
    this.loadSnapshot();
  }

  private async fetchSnapshot(): Promise<void> {
    if (!this.active()) return;
    const readGeneration = this.generation;
    const controller = new AbortController();
    this.pageRead = controller;
    this.pending.open();
    try {
      const { query } = this.view;
      const page = await this.session.client.users(query, controller.signal);
      const buffered = this.pending.close();
      if (this.isCurrent(readGeneration)) this.showPage(page, buffered);
    } catch (thrown) {
      this.pending.close();
      if (!this.isCurrent(readGeneration)) return;
      const error = toError(thrown, 'The snapshot failed.');
      this.publish({ snapshot: { status: 'error', error } });
    }
  }

  private showPage(page: UsersPage, buffered: Rows): void {
    const userIds = this.heldUserIds(page);
    const kept = onlyUsers(this.held.rows, userIds);
    const rows = applyRowsOf(applySnapshot(kept, page.rows), buffered, userIds);
    this.publish({
      rows,
      page,
      lastUpdateAt: new Date(clock()).toISOString(),
      snapshot: { status: 'loaded', error: null },
    });
    this.alarm.aim(rows);
  }

  /** The rows with `row` applied, or null when the held row is not older. */
  private rowsWith(row: UserRow): Rows | null {
    if (!this.active()) return null;
    const rows = applyRow(this.held.rows, row);
    return rows === this.held.rows ? null : rows;
  }

  private recordsWith(event: LiveEvent): LiveRecords {
    const { userId } = event.row;
    if (userId !== this.view.selected) return this.held.liveRecords;
    return withRequest(this.held.liveRecords, userId, event.request);
  }

  /** Keeps the row and the request of an event only when its row is newer. */
  private applyEvent(event: LiveEvent): void {
    if (!this.active()) return;
    // A known page's rows are held, so its events are already applied.
    if (this.held.page === null) this.pending.add(event.row);
    // Not on the page, selected or kept: nothing of it is held.
    if (!this.isHeld(event.row.userId)) return;
    const rows = this.rowsWith(event.row);
    if (!rows) return;
    const liveRecords = this.recordsWith(event);
    this.publish({ rows, liveRecords, lastUpdateAt: event.at });
    this.alarm.aim(rows);
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
        if (!isLimitExceeded(event) || !this.active()) return;
        this.applyEvent(event);
        // A snapshot may already hold this version; the rejection still happened.
        this.onLimitExceeded(event);
      },
    };
  }
}
