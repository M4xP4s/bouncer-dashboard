import { useEffect, useState } from 'react';
import { createClient, type Client } from './index.ts';

export interface Session {
  token: string;
  /** Aborted when the session ends: on unmount or when the token is refused. */
  signal: AbortSignal;
  client: Client;
  onRefused: () => void;
}

/**
 * One session per token. Mount the caller with `key={token}`, so a new token
 * starts from empty state. Null until the first effect has run.
 */
export function useSession(
  token: string,
  onRefused: () => void,
): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    // Created here, not during render: StrictMode replays effects, and each
    // run needs a controller that is not already aborted.
    const controller = new AbortController();
    const { signal } = controller;
    const refuse = () => {
      if (signal.aborted) return;
      controller.abort();
      onRefused();
    };
    const client = createClient({ token, signal, onRefused: refuse });
    // Publishes the resource this effect owns.
    // oxlint-disable-next-line react/set-state-in-effect
    setSession({ token, signal, client, onRefused: refuse });
    return () => controller.abort();
  }, [token, onRefused]);

  return session;
}
