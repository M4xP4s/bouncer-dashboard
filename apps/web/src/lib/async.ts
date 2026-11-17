/**
 * Wraps `task` so that it runs one at a time. Calls made while it runs merge
 * into a single follow-up run.
 */
export function oneAtATime(task: () => Promise<void>): () => void {
  let running = false;
  let queued = false;

  async function run(): Promise<void> {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  }
  return () => void run();
}

export const toError = (thrown: unknown, fallbackMessage: string): Error =>
  thrown instanceof Error ? thrown : new Error(fallbackMessage);
