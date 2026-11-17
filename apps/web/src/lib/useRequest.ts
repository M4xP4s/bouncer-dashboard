import { useEffect, useRef, useState } from 'react';
import { oneAtATime, toError } from './async.ts';

export interface RequestState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
}

const emptyState = <T>(key: string | null): RequestState<T> => ({
  data: undefined,
  error: null,
  loading: key !== null,
});

/**
 * Loads one resource. A new key cancels the old request and clears the
 * data; a new tick reloads the same key and keeps the data shown meanwhile.
 */
export function useRequest<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  tick: number,
): RequestState<T> {
  const [state, setState] = useState(() => emptyState<T>(key));
  const reload = useRef<(() => void) | null>(null);
  const previous = useRef({ key, tick });
  // A ref, so a new `load` function does not restart the request.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    // The request this effect owns is replaced, so its result goes too.
    // oxlint-disable-next-line react/set-state-in-effect
    setState(emptyState<T>(key));
    if (key === null) return;

    const controller = new AbortController();
    const { signal } = controller;
    const run = oneAtATime(async () => {
      if (signal.aborted) return;
      // Only `loading` changes: a failure stays visible during the reload.
      setState((held) => ({ ...held, loading: true }));
      try {
        const data = await loadRef.current(signal);
        if (!signal.aborted) setState({ data, error: null, loading: false });
      } catch (thrown) {
        if (signal.aborted) return;
        const error = toError(thrown, 'The request failed.');
        setState((held) => ({ ...held, error, loading: false }));
      }
    });
    reload.current = run;
    run();
    return () => {
      controller.abort();
      reload.current = null;
    };
  }, [key]);

  // A new key already loads above; only a new tick for the same key reloads.
  useEffect(() => {
    const sameKey = previous.current.key === key;
    if (sameKey && previous.current.tick !== tick) reload.current?.();
    previous.current = { key, tick };
  }, [key, tick]);

  return state;
}
