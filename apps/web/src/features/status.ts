import type { Status } from '@app/contracts';

/** The Mantine colour of each status, shared by badges, bars and row tints. */
export const STATUS_COLOR = {
  OK: 'green',
  Warning: 'yellow',
  Exceeded: 'red',
} satisfies Record<Status, string>;
