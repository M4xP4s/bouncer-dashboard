// Demo traffic: bursts that spread five users over every status, then a slow
// trickle until Ctrl+C. Optional argument: the API's base URL.
import { setTimeout as delay } from 'node:timers/promises';

const SECOND_MS = 1000;
const REQUEST_TIMEOUT_MS = 5 * SECOND_MS;
const TRICKLE_INTERVAL_MS = 3 * SECOND_MS;

// Of the default quota of 100: three users OK, one Warning at 92% and one
// Exceeded, whose last request is the 429 that raises the alert.
const USERS = [
  { userId: 'user-02', token: 'demo-token-02', burst: 45 },
  { userId: 'user-03', token: 'demo-token-03', burst: 50 },
  { userId: 'user-04', token: 'demo-token-04', burst: 55 },
  { userId: 'user-05', token: 'demo-token-05', burst: 92 },
  { userId: 'user-06', token: 'demo-token-06', burst: 101 },
];

// Checked here, so a mistyped argument fails with this message, not in fetch.
function sampleUrlFromArguments() {
  const value = process.argv[2] ?? 'http://localhost:3000';
  const baseUrl = URL.canParse(value) ? new URL(value) : undefined;
  if (baseUrl?.protocol === 'http:' || baseUrl?.protocol === 'https:') {
    return new URL('/api/sample', baseUrl);
  }
  throw new Error(
    `Expected the API's base URL, such as http://localhost:3000, not "${value}"`,
  );
}

const SAMPLE_URL = sampleUrlFromArguments();

async function send({ userId, token }) {
  const response = await fetch(SAMPLE_URL, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Read to the end, so that the connection is free for the next request.
  await response.arrayBuffer();
  // A 429 is part of the demo; any other failure means the API is not working.
  if (response.status === 200 || response.status === 429) return;
  throw new Error(`${userId}: HTTP ${response.status}`);
}

async function sendBursts() {
  for (const user of USERS) {
    for (let sent = 0; sent < user.burst; sent++) await send(user);
    console.log(`${user.userId}: sent ${user.burst} requests`);
  }
}

async function trickle() {
  console.log('Sending a slow trickle; Ctrl+C stops it.');
  for (;;) {
    for (const user of USERS) {
      await send(user);
      await delay(TRICKLE_INTERVAL_MS);
    }
  }
}

try {
  await sendBursts();
  await trickle();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
