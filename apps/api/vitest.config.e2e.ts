import { defineConfig } from 'vitest/config';

// The real Nest application against a real Redis, which the suite empties.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The files share one Redis database and empty it, so one at a time.
    fileParallelism: false,
    env: {
      // Required by the configuration; the tests listen on a free port.
      PORT: '3000',
      // Database 1 keeps development keys apart, but Pub/Sub spans every
      // database, so the server must be the suite's own (see the README).
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      ADMIN_TOKEN: 'test-admin-token',
      DEMO_USERS:
        'user-01:test-token-01,user-02:test-token-02,user-03:test-token-03,user-04:test-token-04,user-05:test-token-05,User_06-TEST:test-token-06',
    },
  },
});
