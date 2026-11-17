import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAuth,
} from '@app/contracts';
import { createClient as realClient } from './client.ts';
import type { LiveSocket } from './socket.ts';

// A dynamic development-only import keeps fixture payloads out of production bundles.
const fixtures =
  import.meta.env.DEV && import.meta.env.VITE_FIXTURES === '1'
    ? await import('./fixture-client.ts')
    : null;

export const createClient = fixtures ? fixtures.createClient : realClient;
export const clock = fixtures ? fixtures.clock : () => Date.now();
function openRealSocket(token: string): LiveSocket {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
    auth: { token } satisfies SocketAuth,
  });
  // Socket.IO's conditional listener type cannot express this smaller, identical event map.
  return socket as LiveSocket;
}
export const openSocket: (token: string) => LiveSocket = fixtures
  ? fixtures.openSocket
  : openRealSocket;

export type { Client } from './client.ts';
