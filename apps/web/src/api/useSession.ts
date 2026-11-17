import { useEffect, useState } from 'react';
import { createClient, type Client } from './index.ts';

export interface Session {
  token: string;
  signal: AbortSignal;
  client: Client;
  onRefused: () => void;
}

/** Mount the dashboard with key={token}; cleanup ends every operation of that session. */
export function useSession(
  token: string,
  onRefused: () => void,
): Session | null {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    // StrictMode replays effects: each setup must get a fresh, non-aborted controller.
    const controller = new AbortController();
    const refuse = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      onRefused();
    };
    // oxlint-disable-next-line react/set-state-in-effect -- Publish the effect-owned resource; creating it during render reuses an aborted StrictMode controller.
    setSession({
      token,
      signal: controller.signal,
      client: createClient({
        token,
        signal: controller.signal,
        onRefused: refuse,
      }),
      onRefused: refuse,
    });
    return () => controller.abort();
  }, [token, onRefused]);
  return session;
}
