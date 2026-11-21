import { useState } from 'react';
import type { UserRow } from '@app/contracts';
import type { Session } from '../../api/useSession.ts';
import type { LiveUsers } from '../../live/useLiveUsers.ts';
import { toError } from '../../lib/async.ts';

/** Runs one admin action at a time and applies the row it answers with. */
export function useOneAction(session: Session, live: LiveUsers) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { signal } = session;

  /** Resolves true when the server applied the action. */
  async function run(send: () => Promise<UserRow>): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError('');
    try {
      const row = await send();
      if (signal.aborted) return false;
      live.applyRow(row);
      return true;
    } catch (thrown) {
      if (signal.aborted) return false;
      setError(toError(thrown, 'Action failed.').message);
      // The action may have been applied before it failed.
      live.refresh();
      return false;
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }

  return { pending, error, setError, run };
}
