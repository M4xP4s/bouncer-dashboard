/**
 * Times the user list and the analytics with 1000 and then 10000 registered
 * users, one API process and a steady trickle of sample requests. Each read is
 * ten sequential HTTP requests, timed here from sending to the parsed JSON
 * body: what an admin client waits for, not Redis or admission latency. Prints
 * the median and maximum as JSON. It empties the database of TEST_REDIS_URL
 * before and after, so give it a Redis of its own.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  closeRedis,
  connectRedis,
} from '../apps/api/dist/redis/redis.module.js';
import {
  generatedUser,
  REGISTRY_KEYS,
  seedGeneratedUsers,
} from '../apps/api/dist/users/seed-users.js';

const POPULATIONS = [1000, 10000];
const SAMPLES_PER_READ = 10;
const TRAFFIC_INTERVAL_MS = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const STOP_TIMEOUT_MS = 3_000;
const DEFAULT_PORT = 3001;
const MAX_PORT = 65_535;
const ADMIN_TOKEN = 'population-check-admin';
// Each filter matches every generated user, so all of them are read.
const READS = {
  page: '/users?page=10',
  filter: '/users?status=OK&search=user',
  analytics: '/analytics',
};

const redisUrl = process.env.TEST_REDIS_URL;
assert.ok(redisUrl, 'Set TEST_REDIS_URL to a Redis this check may empty.');
const port = portFromEnvironment();
const baseUrl = `http://127.0.0.1:${port}`;

const roundMs = (ms) => Math.round(ms * 10) / 10;

/** Of sorted values, the middle one, or the mean of the middle two. */
function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
assert.equal(median([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5.5);

function portFromEnvironment() {
  const value = process.env.PORT ?? String(DEFAULT_PORT);
  const parsed = Number(value);
  const valid = /^\d+$/.test(value) && parsed >= 1 && parsed <= MAX_PORT;
  assert.ok(valid, `PORT must be a whole number from 1 to ${MAX_PORT}.`);
  return parsed;
}

function get(path, token) {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function adminRead(path) {
  const response = await get(`/admin${path}`, ADMIN_TOKEN);
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.json();
}

function startApi() {
  return spawn(process.execPath, ['apps/api/dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      REDIS_URL: redisUrl,
      ADMIN_TOKEN,
      DEMO_USERS: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

// Ready once the analytics answer.
async function waitUntilListening(api) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert.equal(api.exitCode, null, 'The API exited before it listened.');
    const listening = await adminRead('/analytics').then(
      () => true,
      () => false,
    );
    if (listening) return;
    await delay(READY_POLL_MS);
  }
  throw new Error('The API did not listen in time.');
}

async function stopApi(api) {
  if (!api || api.exitCode !== null) return;
  api.kill('SIGTERM');
  const exited = once(api, 'exit');
  await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
  if (api.exitCode === null) api.kill('SIGKILL');
}

/** One sample request at a time, each from the next user, until `signal`. */
async function sendTraffic(population, signal) {
  const counts = { requests: 0, failed: 0 };
  while (!signal.aborted) {
    const { token } = generatedUser((counts.requests % population) + 1);
    counts.requests++;
    const ok = await get('/sample', token).then(
      (response) => response.ok,
      () => false,
    );
    if (!ok) counts.failed++;
    await delay(TRAFFIC_INTERVAL_MS);
  }
  return counts;
}

async function timeRead(path, population) {
  const samples = [];
  for (let sample = 0; sample < SAMPLES_PER_READ; sample++) {
    const started = performance.now();
    const body = await adminRead(path);
    samples.push(performance.now() - started);
    // A list read counts its matches; the analytics count every user.
    assert.equal(body.total ?? body.totalUsers, population, path);
  }
  samples.sort((a, b) => a - b);
  const medianMs = roundMs(median(samples));
  const maxMs = roundMs(samples.at(-1));
  return { medianMs, maxMs };
}

async function usedMemoryBytes(redis) {
  const info = await redis.info('memory');
  return Number(/^used_memory:(\d+)/m.exec(info)[1]);
}

async function measure(redis, population) {
  const seedStarted = performance.now();
  await seedGeneratedUsers(redis, population, ADMIN_TOKEN);
  const seedMs = roundMs(performance.now() - seedStarted);
  assert.equal(await redis.zCard(REGISTRY_KEYS.ids), population);

  const stopTraffic = new AbortController();
  const traffic = sendTraffic(population, stopTraffic.signal);
  const durations = {};
  try {
    for (const [label, path] of Object.entries(READS)) {
      durations[label] = await timeRead(path, population);
    }
  } finally {
    // Also when a read fails, or the traffic would outlive the check.
    stopTraffic.abort();
    await traffic;
  }
  const { requests, failed } = await traffic;
  assert.equal(failed, 0, `${failed} sample requests failed`);

  const redisBytes = await usedMemoryBytes(redis);
  return {
    population,
    seedMs,
    redisBytes,
    durations,
    sampleRequests: requests,
  };
}

// Fails here, not with a confusing readiness error, if the port is taken.
async function assertPortFree() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  }).catch(() => {
    throw new Error(`Port ${port} is in use; set PORT to a free one.`);
  });
  await new Promise((resolve) => probe.close(resolve));
}

await assertPortFree();

// Registering watches keys, so this connection is used by nothing else.
const redis = await connectRedis(redisUrl, 'population-check');
let api;
try {
  await redis.flushDb();
  api = startApi();
  await waitUntilListening(api);
  const results = [];
  for (const population of POPULATIONS) {
    results.push(await measure(redis, population));
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await stopApi(api);
  try {
    if (redis.isReady) await redis.flushDb();
  } finally {
    await closeRedis(redis);
  }
}
