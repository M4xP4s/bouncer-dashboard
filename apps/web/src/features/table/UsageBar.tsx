import { Progress } from '@mantine/core';
import type { Status } from '@app/contracts';
import { STATUS_COLOR } from '../status.ts';

const FULL_PERCENT = 100;
// A bar without a status, as in Top users, takes the page's primary colour.
const NO_STATUS_COLOR = 'blue';

/**
 * The share of the total used. Hidden from assistive technology: the
 * numbers beside it say the same.
 */
export function UsageBar({
  used,
  total,
  status,
}: {
  used: number;
  total: number;
  status?: Status;
}) {
  // A suspended user is admitted past the total; the bar stops at full.
  const usedPercent = Math.min(FULL_PERCENT, (used / total) * FULL_PERCENT);
  return (
    <Progress
      aria-hidden
      value={usedPercent}
      color={status ? STATUS_COLOR[status] : NO_STATUS_COLOR}
      size="sm"
    />
  );
}
