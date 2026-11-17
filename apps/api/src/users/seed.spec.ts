import { createServer, type AddressInfo } from 'node:net';

/** A loopback port that was free a moment ago and has nothing listening now. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const ARGV = process.argv;

afterEach(() => {
  process.argv = ARGV;
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('seed command', () => {
  it('exits 1 with one JSON line when Redis refuses the connection', async () => {
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${await closedPort()}`);
    vi.stubEnv('ADMIN_TOKEN', 'admin-token');
    vi.stubEnv('DEMO_USERS', '');
    process.argv = [ARGV[0], 'seed.js', '--count', '5'];
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The command runs while its module loads; the import settles after it.
    await import('./seed.js');

    expect(process.exitCode).toBe(1);
    expect(printed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      '{"processed":0,"added":0,"error":"Redis could not be reached or did ' +
        'not answer within 3 s. \\"added\\" counts confirmed batches only; ' +
        'the batch in flight may have been stored. Check Redis, then run the ' +
        'command again: it only adds missing users."}',
    );
  });
});
