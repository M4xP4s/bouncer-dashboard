import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import request, { type Response } from 'supertest';
import { REQUEST_DEADLINE_MS, SECOND_MS } from './application.js';
import { listeningPort } from './listening-port.js';

const CALL_COUNT = 50;
const FIRST_GROUP_SIZE = 25;
const GATE_WAIT_MS = 3 * SECOND_MS;
const FORWARDED_HEADERS = ['content-type', 'x-count', 'retry-after'];

/** A promise and the function that resolves it, to hold a step until released. */
function latch() {
  let resolve = () => {};
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { done, resolve };
}

function copyResponse(
  from: globalThis.Response,
  body: string,
  to: ServerResponse,
) {
  to.statusCode = from.status;
  for (const header of FORWARDED_HEADERS) {
    const value = from.headers.get(header);
    if (value !== null) to.setHeader(header, value);
  }
  to.end(body);
}

/**
 * Forwards the first 25 calls and holds their replies; holds the other 25
 * before forwarding. The admin action lands between the two batches.
 */
class Gate {
  private readonly released = latch();
  private readonly firstGroup = latch();
  private readonly upstream = new AbortController();
  private readonly forwarding: Promise<void>[] = [];
  private readonly server = createServer((incoming, outgoing) =>
    this.accept(incoming, outgoing),
  );
  private arrived = 0;
  private processedEarly = 0;

  private constructor(private readonly apiUrl: string) {}

  static async open(apiUrl: string): Promise<Gate> {
    const gate = new Gate(apiUrl);
    await new Promise<void>((resolve, reject) => {
      gate.server.once('error', reject);
      gate.server.listen(0, '127.0.0.1', resolve);
    });
    return gate;
  }

  get url() {
    return `http://127.0.0.1:${listeningPort(this.server)}`;
  }

  get firstGroupProcessed() {
    return this.firstGroup.done;
  }

  counts() {
    return { arrived: this.arrived, processedEarly: this.processedEarly };
  }

  release() {
    this.released.resolve();
  }

  async close() {
    this.upstream.abort();
    this.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.all(this.forwarding);
  }

  private accept(incoming: IncomingMessage, outgoing: ServerResponse) {
    const early = this.arrived++ < FIRST_GROUP_SIZE;
    this.checkFirstGroup();
    const forwarded = this.forward(incoming, outgoing, early).catch(
      (error: unknown) => {
        // Fail the waiting call rather than leave it hanging.
        outgoing.destroy(new Error('Forwarding failed', { cause: error }));
      },
    );
    this.forwarding.push(forwarded);
  }

  private async forward(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    early: boolean,
  ) {
    if (!early) await this.released.done;
    const response = await fetch(`${this.apiUrl}/api/sample`, {
      headers: { authorization: incoming.headers.authorization ?? '' },
      signal: this.upstream.signal,
    });
    const body = await response.text();
    if (early) this.processedEarly++;
    this.checkFirstGroup();
    await this.released.done;
    copyResponse(response, body, outgoing);
  }

  private checkFirstGroup() {
    if (this.arrived === CALL_COUNT && this.processedEarly === FIRST_GROUP_SIZE)
      this.firstGroup.resolve();
  }
}

function rejectAfter(ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

function fulfilled(results: PromiseSettledResult<Response>[]): Response[] {
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/**
 * Runs an admin action while fifty requests of user-01 are in flight: the
 * first 25 have been decided before it and the other 25 are decided after.
 */
export async function interleavedTraffic(
  apiUrl: string,
  action: () => PromiseLike<Response>,
) {
  const gate = await Gate.open(apiUrl);
  let answered = 0;
  const calls = Array.from({ length: CALL_COUNT }, async () => {
    const response = await request(gate.url)
      .get('/api/sample')
      .set('Authorization', 'Bearer test-token-01')
      .timeout({ deadline: REQUEST_DEADLINE_MS });
    answered++;
    return response;
  });
  // Handle every rejection now: cleanup joins the calls even when the action
  // or an assertion fails before the gate is released.
  const settled = Promise.allSettled(calls);
  const gateWait = rejectAfter(
    GATE_WAIT_MS,
    'The gate did not process its first group',
  );
  try {
    await Promise.race([gate.firstGroupProcessed, gateWait.expired]);
    expect(gate.counts()).toEqual({
      arrived: CALL_COUNT,
      processedEarly: FIRST_GROUP_SIZE,
    });
    expect(answered).toBe(0);

    const changed = await action();
    expect(answered).toBe(0);
    gate.release();

    return { responses: fulfilled(await settled), changed };
  } finally {
    gateWait.cancel();
    await gate.close();
    await settled;
  }
}
