import { useEffect, useRef, useState } from 'react';

export interface RequestState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
}

/** One resource: key changes cancel; same-key refreshes queue once without hiding data. */
export function useRequest<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  tick: number,
): RequestState<T> {
  const [state, setState] = useState<RequestState<T>>({
    data: undefined,
    error: null,
    loading: key !== null,
  });
  const loadRef = useRef(load);
  const refreshRef = useRef<(() => void) | null>(null);
  const previous = useRef({ key, tick });

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the view when replacing the external request owner for a new key.
    setState({ data: undefined, error: null, loading: key !== null });
    if (key === null) return;
    let disposed = false;
    let running = false;
    let queued = false;
    let controller: AbortController | null = null;

    const refresh = async () => {
      if (disposed) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      controller = new AbortController();
      const signal = controller.signal;
      // Keep the last failure visible when a reconciliation was queued during this load.
      setState((held) => ({ ...held, loading: true }));
      try {
        const data = await loadRef.current(signal);
        if (!disposed && !signal.aborted)
          setState({ data, error: null, loading: false });
      } catch (error) {
        if (!disposed && !signal.aborted) {
          setState((held) => ({
            ...held,
            error:
              error instanceof Error ? error : new Error('The request failed.'),
            loading: false,
          }));
        }
      } finally {
        running = false;
        if (queued && !disposed) {
          queued = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => {
      void refresh();
    };
    void refresh();
    return () => {
      disposed = true;
      controller?.abort();
      refreshRef.current = null;
    };
  }, [key]);

  useEffect(() => {
    if (previous.current.key === key && previous.current.tick !== tick)
      refreshRef.current?.();
    previous.current = { key, tick };
  }, [key, tick]);
  return state;
}
