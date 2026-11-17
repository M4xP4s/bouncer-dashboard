import { SECOND_MS } from '../lib/time.ts';

const TIMEOUT_SECONDS = 10;
const TIMEOUT_MESSAGE = `The request timed out after ${TIMEOUT_SECONDS} seconds.`;
const NETWORK_MESSAGE =
  'The request failed. Check the connection and try again.';

export class HttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

interface RequestOptions {
  token: string;
  method?: string;
  body?: unknown;
  signal: AbortSignal;
}

function fetchOptions({ token, method = 'GET', body }: RequestOptions) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body === undefined) return { method, headers };

  headers['Content-Type'] = 'application/json';
  return { method, headers, body: JSON.stringify(body) };
}

/** The server's own message when the error body carries one. */
function failureMessage(body: unknown, status: number): string {
  const hasMessage =
    typeof body === 'object' && body !== null && 'message' in body;
  if (hasMessage && typeof body.message === 'string') return body.message;
  return `Request failed (${status}).`;
}

// Resolves with the parsed body. Every failure except a cancellation by
// the caller is an HttpError.
export async function request(
  path: string,
  options: RequestOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_SECONDS * SECOND_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    signal.throwIfAborted();
    const response = await fetch(path, { ...fetchOptions(options), signal });
    const body: unknown = await response.json().catch(() => null);
    // The caller may have cancelled while the body was still being read.
    signal.throwIfAborted();
    if (response.ok) return body;
    throw new HttpError(failureMessage(body, response.status), response.status);
  } catch (error) {
    // A cancellation by the caller stays an AbortError, whatever it caused.
    options.signal.throwIfAborted();
    if (timeout.aborted) throw new HttpError(TIMEOUT_MESSAGE);
    if (error instanceof HttpError) throw error;
    throw new HttpError(NETWORK_MESSAGE);
  }
}
