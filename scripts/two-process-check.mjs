// Starts two API processes on one Redis and checks that they share one quota
// and relay their events and alerts to each other's dashboards. Run it after
// a build, from the repository root, on a Redis server of its own, as the
// README explains: it empties database 1, or the database of TEST_REDIS_URL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { io } from 'socket.io-client';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

// Checked here, so a mistyped value fails with this message and not later.
function redisUrlFromEnvironment() {
  const value = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
  const protocol = URL.canParse(value) ? new URL(value).protocol : undefined;
  if (protocol === 'redis:' || protocol === 'rediss:') return value;
  throw new Error(
    'TEST_REDIS_URL must be a redis:// URL, such as redis://127.0.0.1:6379/1',
  );
}

const REDIS_URL = redisUrlFromEnvironment();
const API_PORTS = [3203, 3204];
const ADMIN_TOKEN = 'two-process-admin';
// user-01 takes the concurrent burst; user-02 the single requests and events.
const BURST_TOKEN = 'two-process-01';
const PROBE_TOKEN = 'two-process-02';
const DEMO_USERS = `user-01:${BURST_TOKEN},user-02:${PROBE_TOKEN}`;
const QUOTA = 100;
const BURST_SIZE = 2 * QUOTA;

const REDIS_TIMEOUT_MS = 3 * SECOND_MS;
const READY_TIMEOUT_MS = 15 * SECOND_MS;
const READY_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 500;
const REQUEST_TIMEOUT_MS = 10 * SECOND_MS;
const EVENT_TIMEOUT_MS = 5 * SECOND_MS;
const EXIT_GRACE_MS = 3 * SECOND_MS;
// With less left of the hour, the burst could span two windows.
const MIN_WINDOW_LEFT_MS = MINUTE_MS;

const children = [];
const dashboards = [];
let cleanedUp = false;

const apiUrl = (port) => `http://127.0.0.1:${port}`;
const hasExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;
// The URL may carry a password.
const redacted = (url) => url.replace(/\/\/[^/@]+@/, '//[redacted]@');

// A short connection per use: with no other traffic on it, the socket timeout
// bounds each wait on a Redis that accepts connections and never answers.
async function withRedis(use) {
  const redis = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: false,
      connectTimeout: REDIS_TIMEOUT_MS,
      socketTimeout: REDIS_TIMEOUT_MS,
    },
  });
  redis.on('error', (error) => console.error('Redis:', error.message));
  try {
    await redis.connect();
    return await use(redis);
  } finally {
    if (redis.isOpen) redis.destroy();
  }
}

const emptyDatabase = () => withRedis((redis) => redis.flushDb());

function sample(port, token) {
  return fetch(`${apiUrl(port)}/api/sample`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function resetUser02(port) {
  return fetch(`${apiUrl(port)}/api/admin/users/user-02/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
}

async function waitForFullWindow() {
  const windowLeftMs = HOUR_MS - (Date.now() % HOUR_MS);
  if (windowLeftMs >= MIN_WINDOW_LEFT_MS) return;
  console.log('Waiting for the next hour boundary');
  await delay(windowLeftMs + SECOND_MS);
}

// Fails here, not with a confusing readiness error, if a port is taken.
async function assertPortFree(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
}

function startApi(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    REDIS_URL,
    ADMIN_TOKEN,
    DEMO_USERS,
  };
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => process.stdout.write(`[${port}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${port}] ${data}`));
  children.push(child);
  return child;
}

async function isHealthy(port) {
  try {
    const response = await fetch(`${apiUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // Not listening yet.
    return false;
  }
}

async function waitUntilReady(port, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited(child)) throw new Error(`API on ${port} exited early`);
    if (await isHealthy(port)) return;
    await delay(READY_POLL_MS);
  }
  throw new Error(`API on ${port} was not ready in ${READY_TIMEOUT_MS} ms`);
}

// The burst alone would also pass if one process answered only 429s.
async function checkSharedCounter() {
  for (const [index, port] of API_PORTS.entries()) {
    const response = await sample(port, PROBE_TOKEN);
    assert.equal(response.status, 200, `Preflight admission on ${port}`);
    assert.equal(response.headers.get('x-count'), String(QUOTA - 1 - index));
  }
  console.log(
    'Both processes admitted against the same counter (99, 98 remaining)',
  );
}

async function checkConcurrentBurst() {
  const portFor = (index) => API_PORTS[index % API_PORTS.length];
  const responses = await Promise.all(
    Array.from({ length: BURST_SIZE }, (_, index) =>
      sample(portFor(index), BURST_TOKEN),
    ),
  );
  const accepted = responses.filter((response) => response.status === 200);
  const denied = responses.filter((response) => response.status === 429);
  const other = BURST_SIZE - accepted.length - denied.length;
  console.log(`200=${accepted.length} 429=${denied.length} other=${other}`);
  assert.equal(accepted.length, QUOTA);
  assert.equal(denied.length, BURST_SIZE - QUOTA);

  const windowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const windowKey = `rl:win:user-01:${windowStart}`;
  assert.equal(await withRedis((redis) => redis.zCard(windowKey)), QUOTA);

  // Strings, not numbers: Number(null) is 0 and would hide a missing header.
  const remainingCounts = accepted
    .map((response) => response.headers.get('x-count'))
    .sort();
  const expectedCounts = Array.from({ length: QUOTA }, (_, remaining) =>
    String(remaining),
  ).sort();
  assert.deepEqual(remainingCounts, expectedCounts);
}

async function connectDashboard(port) {
  const dashboard = io(apiUrl(port), {
    auth: { token: ADMIN_TOKEN },
    reconnection: false,
    timeout: EVENT_TIMEOUT_MS,
  });
  dashboards.push(dashboard);
  await new Promise((resolve, reject) => {
    dashboard.once('connect', resolve);
    dashboard.once('connect_error', reject);
  });
  return dashboard;
}

/** Resolves on the next `rate:update` of user-02 with this cause. */
function nextUpdate(dashboard, cause) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dashboard.off('rate:update', onUpdate);
      reject(new Error(`Missing ${cause} event at a dashboard`));
    }, EVENT_TIMEOUT_MS);
    function onUpdate(event) {
      if (event.cause !== cause || event.row?.userId !== 'user-02') return;
      clearTimeout(timer);
      dashboard.off('rate:update', onUpdate);
      resolve(event);
    }
    dashboard.on('rate:update', onUpdate);
  });
}

/** Sends a call to one process and waits for its event at the dashboards. */
async function expectDelivered(dashboardsToCheck, cause, send) {
  const sendAndCheck = async () => {
    const response = await send();
    assert.equal(response.status, 200, `${cause} answered ${response.status}`);
  };
  const updates = dashboardsToCheck.map((dashboard) =>
    nextUpdate(dashboard, cause),
  );
  // Together, so a failed call is reported at once and not as a missing event.
  await Promise.all([...updates, sendAndCheck()]);
}

function collectBurstAlerts(dashboard) {
  const alerts = [];
  dashboard.on('rate:limit_exceeded', (event) => {
    if (event.row?.userId === 'user-01') alerts.push(event);
  });
  return alerts;
}

// One process emits the alert, so the dashboard on the other can only have it
// through Redis. Both connect before the burst, which uses the window's alert.
async function checkBurstWithAlert(connected) {
  const alertsByDashboard = connected.map(collectBurstAlerts);
  await checkConcurrentBurst();
  // Each process relays its events in order, so an update sent by each after
  // the burst arrives after every alert of the burst.
  for (const port of API_PORTS) {
    await expectDelivered(connected, 'request', () =>
      sample(port, PROBE_TOKEN),
    );
  }
  for (const [index, alerts] of alertsByDashboard.entries()) {
    assert.equal(
      alerts.length,
      1,
      `Alerts at dashboard on ${API_PORTS[index]}`,
    );
  }
  const [first, second] = alertsByDashboard.map(([alert]) => alert);
  assert.equal(first.request.id, second.request.id);
  assert.equal(first.request.outcome, 'denied');
  console.log(
    'One rate:limit_exceeded event, the same at the dashboards on both processes',
  );
}

async function expectRelayed(dashboard, cause, send) {
  await expectDelivered([dashboard], cause, send);
  console.log(`Cross-process ${cause} event received`);
}

async function checkCrossProcessEvents(dashboard) {
  const otherPort = API_PORTS[1];
  await expectRelayed(dashboard, 'request', () =>
    sample(otherPort, PROBE_TOKEN),
  );
  await expectRelayed(dashboard, 'reset', () => resetUser02(otherPort));
}

async function stopApi(child) {
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await Promise.race([exited, delay(EXIT_GRACE_MS)]);
  if (!hasExited(child)) child.kill('SIGKILL');
}

async function cleanUp() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const dashboard of dashboards) dashboard.disconnect();
  await Promise.all(children.map(stopApi));
  // Only the API processes write to the database.
  if (children.length > 0) await emptyDatabase();
}

async function main() {
  console.log(
    `TEST_REDIS_URL=${redacted(REDIS_URL)} API ports=${API_PORTS.join(', ')}`,
  );
  await waitForFullWindow();
  for (const port of API_PORTS) await assertPortFree(port);
  await emptyDatabase();
  const ready = API_PORTS.map((port) => waitUntilReady(port, startApi(port)));
  await Promise.all(ready);
  await checkSharedCounter();
  const connected = await Promise.all(API_PORTS.map(connectDashboard));
  await checkBurstWithAlert(connected);
  await checkCrossProcessEvents(connected[0]);
}

const reportCleanupFailure = (error) => console.error('Cleanup failed:', error);

function cleanUpAndExit() {
  cleanUp()
    .catch(reportCleanupFailure)
    .finally(() => process.exit(1));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, cleanUpAndExit);
}
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanUp().catch((error) => {
    reportCleanupFailure(error);
    process.exitCode = 1;
  });
}
