import {
  Alert,
  Badge,
  Button,
  getDefaultZIndex,
  Group,
  Paper,
  Table,
  Text,
} from '@mantine/core';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { Status, UserRow, UsersPage, UsersQuery } from '@app/contracts';
import type { Client } from '../../api/index.ts';
import { FIRST_PAGE, lastPage } from '../../api/usersQuery.ts';
import type { Session } from '../../api/useSession.ts';
import { pageRows, suspensionEnd, type Rows } from '../../live/rows.ts';
import type { LiveUsers, SnapshotState } from '../../live/useLiveUsers.ts';
import { minutesUntil, utcTime } from '../../lib/time.ts';
import { useOneAction } from '../admin/useOneAction.ts';
import { STATUS_COLOR } from '../status.ts';
import { RowActions, type RowAction } from './RowActions.tsx';
import {
  PageFooter,
  TableToolbar,
  type StatusCounts,
} from './TableControls.tsx';
import { UsageBar } from './UsageBar.tsx';
import { type HeldOrder, useHeldOrder } from './useHeldOrder.ts';

// Wide enough for the bar to read as a share beside "Remaining / Total".
const BAR_WIDTH = 96;
// User IDs run to 64 characters: the ID wraps anywhere, so the badge, the
// counts and the times beside it keep their width and stay on one line.
const ID_BUTTON_STYLES = {
  root: { height: 'auto' },
  inner: { justifyContent: 'flex-start' },
  label: { whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' },
} as const;
const NO_WRAP = { whiteSpace: 'nowrap' } as const;
// The coloured edge that marks a tinted row for a reader who scans the IDs.
const ROW_EDGE = '3px';
const TINTED_STATUSES: ReadonlySet<Status> = new Set(['Warning', 'Exceeded']);
// Kept in view over the rows while the page scrolls, under the field's
// popover and the drawer. The tint is laid over the page colour to be opaque.
const STICKY_ALERT_STYLE = {
  position: 'sticky',
  top: 0,
  zIndex: getDefaultZIndex('app'),
  backgroundColor: 'var(--mantine-color-body)',
  backgroundImage:
    'linear-gradient(var(--mantine-color-red-light), var(--mantine-color-red-light))',
} as const;

export function UsersTable({
  rows,
  page,
  query,
  onQuery,
  snapshot,
  now,
  onSelect,
  counts,
  session,
  live,
}: {
  rows: Rows;
  page: UsersPage | null;
  query: UsersQuery;
  onQuery: (query: UsersQuery) => void;
  snapshot: SnapshotState;
  now: number;
  onSelect: (id: string) => void;
  counts: StatusCounts | undefined;
  session: Session;
  live: LiveUsers;
}) {
  const { rows: shown, ...hold } = useHeldRows(page, rows, query, live.keep);
  const noMatch = snapshot.status === 'loaded' && shown.length === 0;
  const action = useRowAction(session, live);
  useFirstPageWhenPastLast(page, query, onQuery);

  return (
    <Paper withBorder>
      <TableToolbar query={query} onQuery={onQuery} counts={counts} />
      <TableMessages snapshot={snapshot} noMatch={noMatch} action={action} />
      {shown.length > 0 && (
        <UserRowsTable
          rows={shown}
          now={now}
          onSelect={onSelect}
          client={session.client}
          live={live}
          action={action}
          bodyProps={hold.bodyProps}
          onFieldOpened={hold.onFieldOpened}
        />
      )}
      <PageFooter query={query} page={page} onQuery={onQuery} />
    </Paper>
  );
}

/** The held rows; the live session is told which users a hold keeps. */
function useHeldRows(
  page: UsersPage | null,
  rows: Rows,
  query: UsersQuery,
  keep: LiveUsers['keep'],
) {
  // Every field of the query changes the page asked for, so it keys the hold.
  const { heldUserIds, ...hold } = useHeldOrder(
    pageRows(page, rows),
    rows,
    JSON.stringify(query),
  );
  useEffect(() => keep(heldUserIds), [keep, heldUserIds]);
  return hold;
}

// Users can leave a filtered list between two reads, so the page asked for can
// end up past the last.
function useFirstPageWhenPastLast(
  page: UsersPage | null,
  query: UsersQuery,
  onQuery: (query: UsersQuery) => void,
) {
  useEffect(() => {
    if (page && page.page > lastPage(page)) {
      onQuery({ ...query, page: FIRST_PAGE });
    }
  }, [page, query, onQuery]);
}

/** The table's action, with an error that names the user it was for. */
function useRowAction(
  session: Session,
  live: LiveUsers,
): RowAction & { message: string; dismiss: () => void } {
  const { pending, error, setError, run } = useOneAction(session, live);
  const [userId, setUserId] = useState('');
  // Whether the error is an invalid entry rather than a failed request.
  const [entryInvalid, setEntryInvalid] = useState(false);
  return {
    pending,
    message: error && `${userId}: ${error}`,
    dismiss: () => setError(''),
    invalidUserId: error && entryInvalid ? userId : '',
    run: (forUserId, send) => {
      if (pending) return Promise.resolve(false);
      setUserId(forUserId);
      setEntryInvalid(false);
      return run(send);
    },
    invalid: (forUserId, message) => {
      setUserId(forUserId);
      setEntryInvalid(true);
      setError(message);
    },
  };
}

function TableMessages({
  snapshot,
  noMatch,
  action,
}: {
  snapshot: SnapshotState;
  noMatch: boolean;
  action: { message: string; dismiss: () => void };
}) {
  return (
    <>
      {snapshot.status === 'pending' && (
        <Text px="md" py="sm">
          Loading users…
        </Text>
      )}
      {snapshot.status === 'error' && (
        <Alert color="red" m="sm">
          Could not load users: {snapshot.error.message}
        </Alert>
      )}
      {action.message && (
        // Closable: it stays over the first row until another action.
        <Alert
          color="red"
          role="alert"
          m="sm"
          style={STICKY_ALERT_STYLE}
          withCloseButton
          closeButtonLabel="Dismiss"
          onClose={action.dismiss}
        >
          {action.message}
        </Alert>
      )}
      {noMatch && (
        <Text px="md" py="sm">
          No users match the filters.
        </Text>
      )}
    </>
  );
}

function UserRowsTable({
  rows,
  bodyProps,
  ...rowProps
}: {
  rows: UserRow[];
  bodyProps: HeldOrder['bodyProps'];
} & Omit<UserTableRowProps, 'row'>) {
  return (
    <Table.ScrollContainer minWidth={900} type="native">
      <Table highlightOnHover verticalSpacing="xs" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>User ID</Table.Th>
            <Table.Th>Remaining / Total</Table.Th>
            <Table.Th>Reset Time</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Last Request</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody {...bodyProps}>
          {rows.map((row) => (
            <UserTableRow key={row.userId} row={row} {...rowProps} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** The tint and edge of a Warning or Exceeded row; none for OK. */
function rowTint(status: Status) {
  if (!TINTED_STATUSES.has(status)) return { row: undefined, edge: undefined };
  const color = STATUS_COLOR[status];
  return {
    row: `var(--mantine-color-${color}-0)`,
    edge: `inset ${ROW_EDGE} 0 0 var(--mantine-color-${color}-6)`,
  };
}

interface UserTableRowProps {
  row: UserRow;
  now: number;
  onSelect: (id: string) => void;
  client: Client;
  live: LiveUsers;
  action: RowAction;
  onFieldOpened: HeldOrder['onFieldOpened'];
}

function UserTableRow({
  row,
  now,
  onSelect,
  client,
  live,
  action,
  onFieldOpened,
}: UserTableRowProps) {
  const tint = rowTint(row.status);
  const { idButton, rowAction, open } = useRowFocus(
    row.userId,
    onSelect,
    action,
  );
  return (
    // Anywhere on the row opens the panel; the ID button is its keyboard way.
    <Table.Tr bg={tint.row} style={{ cursor: 'pointer' }} onClick={open}>
      <Table.Td style={{ boxShadow: tint.edge }}>
        {/* Its click reaches the row, which opens the panel. */}
        <Button
          ref={idButton}
          variant="subtle"
          size="compact-sm"
          fw={600}
          px={0}
          styles={ID_BUTTON_STYLES}
        >
          {row.userId}
        </Button>
      </Table.Td>
      <UsageCell row={row} />
      <UserTableCells row={row} now={now} />
      <Table.Td>
        <RowActions
          row={row}
          client={client}
          live={live}
          action={rowAction}
          onFieldOpened={(opened) => onFieldOpened(row.userId, opened)}
        />
      </Table.Td>
    </Table.Tr>
  );
}

/** The row's ID button, and the opening and action that return focus to it. */
function useRowFocus(
  userId: string,
  onSelect: (id: string) => void,
  action: RowAction,
) {
  const idButton = useRef<HTMLButtonElement>(null);
  const rowAction = useFocusAfterAction(action, idButton);
  // The drawer returns focus to what held it on opening: the ID button.
  const open = () => {
    // Without scrolling: the row clicked is already in view.
    idButton.current?.focus({ preventScroll: true });
    onSelect(userId);
  };
  return { idButton, rowAction, open };
}

// A browser drops focus to the page when the focused button is disabled or
// removed, which every row action does.
const focusIsLost = () =>
  !document.activeElement || document.activeElement === document.body;

/**
 * The row's action, putting focus back once an action it started settles and
 * focus was left on the page: on the control pressed if it is still there and
 * enabled, otherwise on the row's ID button.
 */
function useFocusAfterAction(
  action: RowAction,
  idButton: RefObject<HTMLButtonElement | null>,
): RowAction {
  const pressed = useRef<Element | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (action.pending || !started.current) return;
    started.current = false;
    if (!focusIsLost()) return;
    const control = pressed.current;
    if (
      control instanceof HTMLElement &&
      control.isConnected &&
      control.matches(':enabled')
    ) {
      control.focus();
      return;
    }
    idButton.current?.focus();
  }, [action.pending, idButton]);
  return {
    ...action,
    run: (userId, send) => {
      if (!action.pending) {
        started.current = true;
        pressed.current = document.activeElement;
      }
      return action.run(userId, send);
    },
  };
}

function UsageCell({ row }: { row: UserRow }) {
  return (
    <Table.Td style={NO_WRAP}>
      <Group gap="sm" wrap="nowrap">
        <div style={{ width: BAR_WIDTH }}>
          <UsageBar used={row.used} total={row.total} status={row.status} />
        </div>
        <Text span>
          {row.remaining} / {row.total}
        </Text>
      </Group>
    </Table.Td>
  );
}

/** Reset Time, Status and Last Request. */
function UserTableCells({ row, now }: { row: UserRow; now: number }) {
  const suspendedUntil = suspensionEnd(row, now);
  return (
    <>
      <Table.Td style={NO_WRAP}>
        {utcTime(row.resetAt)} ({minutesUntil(row.resetAt, now)}m)
      </Table.Td>
      <Table.Td>
        <Badge color={STATUS_COLOR[row.status]} miw="max-content">
          {row.status}
        </Badge>
        {suspendedUntil && (
          <Text size="xs" c="dimmed">
            Throttling suspended until {utcTime(suspendedUntil)}
          </Text>
        )}
      </Table.Td>
      <Table.Td style={NO_WRAP}>
        {row.lastRequestAt ? utcTime(row.lastRequestAt) : 'Never'}
      </Table.Td>
    </>
  );
}
