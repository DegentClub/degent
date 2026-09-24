/** Errors the API maps 1:1 to `{ error: { code, message, details? } }`. Codes are enumerated in the contract. */
export type ErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'not_found'
  | 'quota_exceeded'
  | 'cost_cap_reached'
  | 'job_failed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'range_unreachable'
  | 'provider_unavailable'
  | 'review_rejected';

export class AtelierError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AtelierError';
  }
}

export const validation = (message: string, details?: unknown) => new AtelierError(422, 'validation_failed', message, details);
export const notFound = (what: string) => new AtelierError(404, 'not_found', `${what} not found`);

/**
 * Raised by provider adapters. `message` is safe to show; `internal` is for the log only and is
 * scrubbed of anything that looks like a credential before it gets there.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly internal: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Remove bearer tokens / sk-… keys from text destined for logs. */
export function scrub(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\b(api[_-]?key|token|secret)(["']?\s*[:=]\s*["']?)[^\s"',&]{6,}/gi, '$1$2[redacted]');
}
