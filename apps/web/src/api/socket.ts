import type { ServerToClientEvents } from '@app/contracts';

export interface SocketEvents extends ServerToClientEvents {
  connect: () => void;
  disconnect: () => void;
  connect_error: (error: Error) => void;
}

/** The surface the live session needs; fixture mode implements it too. */
export interface LiveSocket {
  readonly active: boolean;
  on<K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]): void;
  off<K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]): void;
  disconnect(): void;
}

/** Adds every handler and returns the function that removes exactly those. */
export function listen(socket: LiveSocket, handlers: SocketEvents): () => void {
  // Object.keys returns string[]; the keys of a SocketEvents are its events.
  const events = Object.keys(handlers) as (keyof SocketEvents)[];
  for (const event of events) socket.on(event, handlers[event]);
  return () => {
    for (const event of events) socket.off(event, handlers[event]);
  };
}
