import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { deferred } from './test-helpers.ts';
import { useRequest } from './useRequest.ts';

const mockLoad = () => vi.fn<(signal: AbortSignal) => Promise<string>>();

/** The signal the hook passed to the given call of `load`, counted from 0. */
const signalOfCall = (load: ReturnType<typeof mockLoad>, call: number) =>
  load.mock.calls[call][0];

/** Lets already settled loads reach the hook's state. */
const settle = () => act(async () => {});

it('clears the old key, aborts its load and ignores its late data and errors', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const load = mockLoad()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(
    ({ key }) => useRequest(key, load, 0),
    { initialProps: { key: 'A' } },
  );
  const signalOfA = signalOfCall(load, 0);

  rerender({ key: 'B' });
  expect(signalOfA.aborted).toBe(true);
  expect(result.current.data).toBeUndefined();

  await act(async () => second.resolve('B data'));
  await act(async () => first.reject(new Error('old error')));
  expect(result.current).toEqual({
    data: 'B data',
    error: null,
    loading: false,
  });
});

it('coalesces refreshes during a running request without aborting it', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const load = mockLoad()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(
    ({ tick }) => useRequest('A', load, tick),
    { initialProps: { tick: 0 } },
  );

  rerender({ tick: 1 });
  rerender({ tick: 2 });
  expect(load).toHaveBeenCalledTimes(1);
  expect(signalOfCall(load, 0).aborted).toBe(false);

  await act(async () => first.resolve('first'));
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ data: 'first', error: null, loading: true });

  await act(async () => second.resolve('fresh'));
  expect(result.current).toEqual({
    data: 'fresh',
    error: null,
    loading: false,
  });
});

it('keeps prior data during a refresh and reports a resource-local failure', async () => {
  const next = deferred<string>();
  const load = mockLoad()
    .mockResolvedValueOnce('held')
    .mockReturnValueOnce(next.promise);
  const { result, rerender } = renderHook(
    ({ tick }) => useRequest('A', load, tick),
    { initialProps: { tick: 0 } },
  );
  await settle();

  rerender({ tick: 1 });
  expect(result.current.data).toBe('held');
  expect(result.current.loading).toBe(true);

  const error = new Error('history unavailable');
  await act(async () => next.reject(error));
  expect(result.current).toEqual({ data: 'held', error, loading: false });
});

it('retains a fast failure during the next refresh and clears it only on success', async () => {
  const error = new Error('Service unavailable');
  const next = deferred<string>();
  const load = mockLoad()
    .mockRejectedValueOnce(error)
    .mockReturnValueOnce(next.promise);
  const { result, rerender } = renderHook(
    ({ tick }) => useRequest('analytics', load, tick),
    { initialProps: { tick: 0 } },
  );
  await settle();
  expect(result.current.error).toBe(error);

  rerender({ tick: 1 });
  expect(result.current).toEqual({ data: undefined, error, loading: true });

  await act(async () => next.resolve('recovered'));
  expect(result.current).toEqual({
    data: 'recovered',
    error: null,
    loading: false,
  });
});

it('drops the first A response after switching A to B to A', async () => {
  const firstA = deferred<string>();
  const b = deferred<string>();
  const nextA = deferred<string>();
  const load = mockLoad()
    .mockReturnValueOnce(firstA.promise)
    .mockReturnValueOnce(b.promise)
    .mockReturnValueOnce(nextA.promise);
  const { result, rerender } = renderHook(
    ({ key }) => useRequest(key, load, 0),
    { initialProps: { key: 'A' } },
  );

  rerender({ key: 'B' });
  rerender({ key: 'A' });
  await act(async () => nextA.resolve('second A'));
  await act(async () => b.resolve('B'));
  await act(async () => firstA.resolve('first A'));

  expect(result.current.data).toBe('second A');
});

it('a null key cancels and clears; unmount aborts without starting a queued refresh', async () => {
  const pending = deferred<string>();
  const load = mockLoad().mockReturnValue(pending.promise);
  interface Props {
    key: string | null;
    tick: number;
  }
  const initialProps: Props = { key: 'A', tick: 0 };
  const { result, rerender, unmount } = renderHook(
    ({ key, tick }: Props) => useRequest(key, load, tick),
    { initialProps },
  );

  rerender({ key: null, tick: 0 });
  expect(signalOfCall(load, 0).aborted).toBe(true);
  expect(result.current).toEqual({
    data: undefined,
    error: null,
    loading: false,
  });

  rerender({ key: 'B', tick: 0 });
  rerender({ key: 'B', tick: 1 });
  unmount();
  await act(async () => pending.resolve('late'));
  expect(signalOfCall(load, 1).aborted).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

it('a changed load callback does not restart a request, and the next refresh uses it', async () => {
  const first = vi.fn().mockResolvedValue('first');
  const next = vi.fn().mockResolvedValue('next');
  const { result, rerender } = renderHook(
    ({ load, tick }) => useRequest('A', load, tick),
    { initialProps: { load: first, tick: 0 } },
  );
  await settle();

  rerender({ load: next, tick: 0 });
  expect(next).not.toHaveBeenCalled();

  rerender({ load: next, tick: 1 });
  await settle();
  expect(result.current.data).toBe('next');
});
