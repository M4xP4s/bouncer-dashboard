import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { connectRedis } from './redis.module.js';

/** A TCP server on a free loopback port; no Redis is involved. */
async function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `redis://127.0.0.1:${port}` };
}

describe('connectRedis', () => {
  it('fails at once when nothing listens, naming the host and not the URL', async () => {
    const { server, url } = await listen();
    await new Promise((resolve) => server.close(resolve));

    await expect(connectRedis(url.replace('//', '//:secret@'))).rejects.toThrow(
      /^Cannot connect to Redis at 127\.0\.0\.1:\d+ (?!.*secret)/,
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
});
