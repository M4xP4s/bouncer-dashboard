import { createServer, type Server, Socket } from 'node:net';
import { listeningPort } from './listening-port.js';

/**
 * A TCP relay in front of Redis. Stopped, it resets and refuses connections;
 * frozen, it keeps them open and silent.
 */
export class Relay {
  private readonly pairs = new Set<[Socket, Socket]>();
  private frozen = false;
  private server: Server | undefined;
  // Kept after the first start, so a restart serves the same address.
  private listenPort = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  /** Listens, on the port of the previous start if there was one. */
  start() {
    return new Promise<number>((resolve, reject) => {
      this.frozen = false;
      const listening = createServer((client) => this.relay(client));
      this.server = listening;
      // A port that cannot be taken again must fail the test, not hang it.
      listening.once('error', reject);
      listening.listen(this.listenPort, '127.0.0.1', () => {
        this.listenPort = listeningPort(listening);
        resolve(this.listenPort);
      });
    });
  }

  /** Resets every connection and stops listening; safe to call twice. */
  stop() {
    return new Promise<void>((resolve) => {
      for (const [client, upstream] of this.pairs) {
        client.destroy();
        upstream.destroy();
      }
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  freeze() {
    this.frozen = true;
  }

  thaw() {
    this.frozen = false;
  }

  private relay(client: Socket) {
    const upstream = new Socket().connect(this.port, this.host);
    const pair: [Socket, Socket] = [client, upstream];
    this.pairs.add(pair);
    client.on('data', (chunk) => {
      if (!this.frozen) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!this.frozen) client.write(chunk);
    });
    const drop = () => {
      client.destroy();
      upstream.destroy();
      this.pairs.delete(pair);
    };
    client.on('close', drop).on('error', drop);
    upstream.on('close', drop).on('error', drop);
  }
}

const REDIS_DEFAULT_PORT = 6379;

/** A relay in front of the Redis server that `target` names. */
export function relayToRedis(target: URL): Relay {
  // Through the relay, TLS would check the certificate against 127.0.0.1.
  if (target.protocol !== 'redis:')
    throw new Error(`The relay supports redis: URLs, not ${target.protocol}`);
  return new Relay(target.hostname, Number(target.port || REDIS_DEFAULT_PORT));
}

/** `target` with its host and port replaced by those of the relay. */
export function throughRelay(target: URL, relayPort: number): string {
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(relayPort);
  return url.href;
}
