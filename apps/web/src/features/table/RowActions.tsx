import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { Button, Group, Popover } from '@mantine/core';
import type { Status, UserRow } from '@app/contracts';
import type { Client } from '../../api/index.ts';
import { useRequest } from '../../lib/useRequest.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { MAX_REQUESTS, NumberForm } from '../admin/AdminForms.tsx';

const STATUSES_WITH_CONTROLS: ReadonlySet<Status> = new Set([
  'Warning',
  'Exceeded',
]);
// What the field offers before it is changed: enough to unblock a user.
const EXTRA_REQUESTS_OFFERED = 50;

/** The table's one action at a time, with its error naming the user. */
export interface RowAction {
  pending: boolean;
  /** Resolves true when the server applied the action. */
  run: (userId: string, send: () => Promise<UserRow>) => Promise<boolean>;
  invalid: (userId: string, message: string) => void;
  /** The user whose field holds the invalid entry the error is about, or ''. */
  invalidUserId: string;
}

// The controls and their portalled field handle their own clicks; the rest of
// the row opens the panel.
const keepClickInControls = (event: MouseEvent) => event.stopPropagation();

/**
 * Reset usage and Add extra for a Warning or Exceeded row. An open Add extra
 * field stays until it is submitted or closed, even if the row turns OK.
 */
export function RowActions({
  row,
  client,
  live,
  action,
  onFieldOpened,
}: {
  row: UserRow;
  client: Client;
  live: LiveUsers;
  action: RowAction;
  /** Told when the field opens or closes: the table holds its rows meanwhile. */
  onFieldOpened: (opened: boolean) => void;
}) {
  const [extraOpen, setExtraOpen] = useState(false);
  useRowReadWhile(extraOpen, row.userId, client, live);
  const openExtra = (opened: boolean) => {
    setExtraOpen(opened);
    onFieldOpened(opened);
  };
  if (!STATUSES_WITH_CONTROLS.has(row.status) && !extraOpen) return null;

  const { userId } = row;
  return (
    <Group gap="xs" wrap="nowrap" onClick={keepClickInControls}>
      <AddExtra
        userId={userId}
        client={client}
        action={action}
        opened={extraOpen}
        onOpened={openExtra}
      />
      <Button
        size="compact-sm"
        variant="default"
        aria-label={`Reset usage of ${userId}`}
        disabled={action.pending}
        onClick={() => void action.run(userId, () => client.reset(userId))}
      >
        Reset usage
      </Button>
    </Group>
  );
}

/**
 * Reads the user's detail when `open` begins and on every tick, and applies
 * its row. The table holds the row of an open field also once the page read
 * no longer lists the user, and no other read would then cover it. A failed
 * read leaves the row as it was.
 */
function useRowReadWhile(
  open: boolean,
  userId: string,
  client: Client,
  live: LiveUsers,
) {
  const detail = useRequest(
    open ? `row:${userId}` : null,
    (signal) => client.detail(userId, signal),
    live.tick,
  );
  const { applyDetailRow } = live;
  useEffect(() => {
    if (detail.data) applyDetailRow(detail.data.row);
  }, [detail.data, applyDetailRow]);
}

/** The Add extra button and the field it opens. */
function AddExtra({
  userId,
  client,
  action,
  opened,
  onOpened,
}: {
  userId: string;
  client: Client;
  action: RowAction;
  opened: boolean;
  onOpened: (opened: boolean) => void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  // Focus goes back to the button before the field closes, as on Escape; the
  // row moves it to its ID button if the controls go with the field.
  const close = () => {
    opener.current?.focus();
    onOpened(false);
  };
  return (
    <Popover
      opened={opened}
      onChange={onOpened}
      position="bottom-end"
      shadow="md"
      trapFocus
      returnFocus
      // Never hidden while open: its focus trap would hold focus in an
      // invisible field once the row scrolls out of view.
      hideDetached={false}
    >
      <Popover.Target>
        <Button
          ref={opener}
          size="compact-sm"
          aria-label={`Add extra to ${userId}`}
          onClick={() => onOpened(!opened)}
        >
          Add extra
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <ExtraRequestsForm
          userId={userId}
          client={client}
          action={action}
          onApplied={close}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

function ExtraRequestsForm({
  userId,
  client,
  action,
  onApplied,
}: {
  userId: string;
  client: Client;
  action: RowAction;
  onApplied: () => void;
}) {
  const addExtra = async (amount: number) => {
    const applied = await action.run(userId, () =>
      client.addExtra(userId, { amount }),
    );
    if (applied) onApplied();
    return applied;
  };
  return (
    <NumberForm
      label="Extra requests"
      button="Add extra"
      max={MAX_REQUESTS}
      initialValue={EXTRA_REQUESTS_OFFERED}
      disabled={action.pending}
      invalid={action.invalidUserId === userId}
      onInvalid={(message) => action.invalid(userId, message)}
      onSubmit={addExtra}
    />
  );
}
