import type { Issue } from './guards.js';

/** Base class: every failure the client throws (except a caller abort) is a `MeterError`. */
export class MeterError extends Error {
  constructor(
    message: string,
    /** Endpoint path, e.g. `/api/meter`. */
    readonly endpoint: string,
    /** Attempts made (1 = no retry). */
    readonly attempts: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Non-2xx response. `body` is the parsed JSON (or text) the server returned. */
export class MeterHttpError extends MeterError {
  constructor(
    message: string,
    endpoint: string,
    attempts: number,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message, endpoint, attempts);
  }
}

/** DNS / TCP / TLS failure; no HTTP response was received. */
export class MeterNetworkError extends MeterError {
  constructor(message: string, endpoint: string, attempts: number, override readonly cause?: unknown) {
    super(message, endpoint, attempts);
  }
}

/** A single attempt exceeded `timeoutMs` (and retries, if any, were exhausted). */
export class MeterTimeoutError extends MeterError {
  constructor(endpoint: string, attempts: number, readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms calling ${endpoint}`, endpoint, attempts);
  }
}

/**
 * The response did not match the documented shape: the API contract drifted. Never retried and
 * never papered over; `issues` lists each mismatch with its JSON path.
 */
export class MeterContractError extends MeterError {
  constructor(
    endpoint: string,
    readonly issues: Issue[],
    readonly body: unknown,
  ) {
    super(
      `block.space contract drift on ${endpoint}: ` +
        issues
          .slice(0, 5)
          .map((i) => `${i.path} expected ${i.expected}, got ${i.got}`)
          .join('; ') +
        (issues.length > 5 ? ` (+${issues.length - 5} more)` : ''),
      endpoint,
      1,
    );
  }
}
