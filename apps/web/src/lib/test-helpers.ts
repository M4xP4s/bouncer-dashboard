import { vi } from 'vitest';
import type { Client } from '../api/client.ts';
import type { LiveSocket, SocketEvents } from '../api/socket.ts';

export function deferred<T>() {
  // The promise executor runs at once, so both are assigned before the return.
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function mockClient() {
  return {
    users: vi.fn<Client['users']>(),
    detail: vi.fn<Client['detail']>(),
    history: vi.fn<Client['history']>(),
    analytics: vi.fn<Client['analytics']>(),
    reset: vi.fn<Client['reset']>(),
    setLimit: vi.fn<Client['setLimit']>(),
    suspend: vi.fn<Client['suspend']>(),
    unsuspend: vi.fn<Client['unsuspend']>(),
    addExtra: vi.fn<Client['addExtra']>(),
  };
}

export function mockSocket() {
  const listeners: { [K in keyof SocketEvents]: Set<SocketEvents[K]> } = {
    connect: new Set(),
    disconnect: new Set(),
    connect_error: new Set(),
    'rate:update': new Set(),
    'rate:limit_exceeded': new Set(),
  };
  const socket: LiveSocket = {
    active: true,
    on: vi.fn(
      <K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]) => {
        listeners[event].add(listener);
      },
    ),
    off: vi.fn(
      <K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]) => {
        listeners[event].delete(listener);
      },
    ),
    disconnect: vi.fn(),
  };
  return { ...socket, listeners };
}
