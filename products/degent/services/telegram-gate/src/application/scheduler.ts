/** Runs `task` every `intervalMs` until `signal` aborts; one run at a time, errors logged, never thrown. */
import type { Logger } from './logger.js';

export async function runEvery(intervalMs: number, task: () => Promise<unknown>, signal: AbortSignal, log: Logger): Promise<void> {
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) return;
    try {
      await task();
    } catch (e) {
      log.error('gate: scheduled task failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
