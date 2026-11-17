import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { DisconnectsClientError } from 'redis';
import { closeRedis, connectRedis } from './redis.module.js';

/** A TCP server on a free loopback port; no Redis is involved. */
async function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `redis://127.0.0.1:${port}` };
}

/** Closes each fake peer of the running test, also one that failed early. */
const peerClosers: Array<() => Promise<void>> = [];

/** Answers every command with `+OK` until told to hang; not a real Redis. */
async function listenAsRedis() {
  const { server, url } = await listen();
  const sockets: Socket[] = [];
  let hung = false;
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('data', (chunk) => {
      // Each command arrives as one RESP array, which starts a line with `*`.
      const commands = chunk.toString().match(/^\*\d+\r\n/gm) ?? [];
      if (!hung) socket.write('+OK\r\n'.repeat(commands.length));
    });
  });
  peerClosers.push(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url,
    connectionCount: () => sockets.length,
    hang: () => {
      hung = true;
    },
    answer: () => {
      hung = false;
    },
  };
}

// Writes restart the socket timeout, so under this traffic only the watchdog
// can notice a peer that stops answering.
const TRAFFIC_INTERVAL_MS = 500;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// Two watchdog checks and a margin, with the default check every second.
const TWO_CHECKS_MS = 2500;
// 3 s of silence after the last reply, which may precede the hang by a
// second, and one watchdog check.
const DETECTION_LIMIT_MS = 5000;
const RECOVERY_LIMIT_MS = 3000;
const OUTAGE_TEST_TIMEOUT_MS = 10_000;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(peerClosers.splice(0).map((close) => close()));
});

describe('connectRedis', () => {
  it('fails at once when nothing listens, naming the host and the reason, not the URL', async () => {
    const { server, url } = await listen();
    await new Promise((resolve) => server.close(resolve));
    // `localhost` may resolve to two addresses; the reason must survive that.
    const closed = url.replace('//127.0.0.1', '//:secret@localhost');

    await expect(connectRedis(closed)).rejects.toThrow(
      /^Cannot connect to Redis at localhost:\d+ \((?!.*secret).*ECONNREFUSED/,
    );
  });

  it('fails within seconds when the peer accepts and never answers', async () => {
    const { server, url } = await listen();
    // Accept the connection, read what arrives and say nothing.
    const sockets: Socket[] = [];
    server.on('connection', (socket) => sockets.push(socket.resume()));

    try {
      await expect(connectRedis(url)).rejects.toThrow(
        'Cannot connect to Redis',
      );
    } finally {
      sockets.forEach((socket) => socket.destroy());
      server.close();
    }
  }, 6000);

  it(
    'cuts off a peer that stops answering under traffic, then works again',
    async () => {
      // The wall clock stands still, so only a monotonic clock sees the silence.
      vi.useFakeTimers({ toFake: ['Date'] });
      const peer = await listenAsRedis();
      const client = await connectRedis(peer.url);
      const traffic = setInterval(
        () => client.ping().catch(() => {}),
        TRAFFIC_INTERVAL_MS,
      );

      try {
        peer.hang();
        const hungAt = performance.now();
        await expect(client.ping()).rejects.toThrow(DisconnectsClientError);
        expect(performance.now() - hungAt).toBeLessThan(DETECTION_LIMIT_MS);

        peer.answer();
        await vi.waitFor(
          () => expect(client.isReady).toBe(true),
          RECOVERY_LIMIT_MS,
        );
        await expect(client.ping()).resolves.toBe('OK');
      } finally {
        clearInterval(traffic);
        await closeRedis(client);
      }
    },
    OUTAGE_TEST_TIMEOUT_MS,
  );

  it(
    'cuts off a peer that stops answering while idle, then works again',
    async () => {
      const peer = await listenAsRedis();
      const client = await connectRedis(peer.url);

      try {
        peer.hang();
        const hungAt = performance.now();
        // The PING left waiting fails as the connection is cut off. Answer at
        // once, before the reconnect's first commands, as the case above does.
        await new Promise((resolve) => client.once('error', resolve));
        peer.answer();

        expect(performance.now() - hungAt).toBeLessThan(DETECTION_LIMIT_MS);
        expect(client.isReady).toBe(false);
        await vi.waitFor(
          () => expect(client.isReady).toBe(true),
          RECOVERY_LIMIT_MS,
        );
        await expect(client.ping()).resolves.toBe('OK');
      } finally {
        await closeRedis(client);
      }
    },
    OUTAGE_TEST_TIMEOUT_MS,
  );

  it('removes the listeners of its watchdog once the connection is closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const peer = await listenAsRedis();
    const client = await connectRedis(peer.url);
    const listenerCounts = () => [
      client.listenerCount('ready'),
      client.listenerCount('ping-interval'),
    ];
    const [readyBefore, pingBefore] = listenerCounts();

    await closeRedis(client);
    vi.advanceTimersByTime(TWO_CHECKS_MS);

    expect(listenerCounts()).toEqual([readyBefore - 1, pingBefore - 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a healthy connection when the wall clock jumps forward', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const peer = await listenAsRedis();
    const client = await connectRedis(peer.url);
    const start = Date.now();
    let reading = 0;
    // Each reading of the wall clock is a year after the one before.
    vi.spyOn(Date, 'now').mockImplementation(() => start + ++reading * YEAR_MS);

    try {
      vi.advanceTimersByTime(TWO_CHECKS_MS);

      expect(client.isReady).toBe(true);
      expect(peer.connectionCount()).toBe(1);
      await expect(client.ping()).resolves.toBe('OK');
    } finally {
      await closeRedis(client);
    }
  });
});
