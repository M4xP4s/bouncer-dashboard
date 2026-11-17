import type { ServerToClientEvents } from '@app/contracts';

export interface SocketEvents extends ServerToClientEvents {
  connect: () => void;
  disconnect: () => void;
  connect_error: (error: Error) => void;
}

/** Only the surface the one live owner needs, also implemented by fixture mode. */
export interface LiveSocket {
  readonly active: boolean;
  on<K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]): void;
  off<K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]): void;
  disconnect(): void;
}
