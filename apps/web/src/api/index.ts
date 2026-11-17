import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAuth,
} from '@app/contracts';
import { createClient as realClient } from './client.ts';
import type { LiveSocket } from './socket.ts';

export type { Client } from './client.ts';

// Imported only by a development server started with VITE_FIXTURES=1, so a
// production bundle holds no fixture data.
const fixtures =
  import.meta.env.DEV && import.meta.env.VITE_FIXTURES === '1'
    ? await import('./fixture-client.ts')
    : null;

function openRealSocket(token: string): LiveSocket {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
    auth: { token } satisfies SocketAuth,
  });
  // Socket.IO's conditional listener type cannot express LiveSocket's
  // smaller, identical event map.
  return socket as LiveSocket;
}

export const createClient = fixtures?.createClient ?? realClient;
export const openSocket: (token: string) => LiveSocket =
  fixtures?.openSocket ?? openRealSocket;
/** The current time in milliseconds; fixture mode pins it to its data. */
export const clock = fixtures?.clock ?? (() => Date.now());
