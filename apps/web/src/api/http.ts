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

/** The transport boundary; caller cancellation must survive JSON parsing too. */
export async function request(
  path: string,
  options: RequestOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    signal.throwIfAborted();
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string'
          ? body.message
          : `Request failed (${response.status}).`;
      throw new HttpError(message, response.status);
    }
    return body;
  } catch (error) {
    options.signal.throwIfAborted();
    if (timeout.aborted)
      throw new HttpError('The request timed out after 10 seconds.');
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      'The request failed. Check the connection and try again.',
    );
  }
}
