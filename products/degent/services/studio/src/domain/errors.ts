/** Domain errors carrying an API error code and HTTP status. Messages are safe to show users. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string) => new DomainError('not_found', 404, `${what} not found`);
export const conflict = (message: string, details?: unknown) => new DomainError('conflict', 409, message, details);
export const invalid = (message: string, details?: unknown) => new DomainError('validation_failed', 422, message, details);
export const unauthorized = (message: string) => new DomainError('unauthorized', 401, message);
export const forbidden = (message: string) => new DomainError('forbidden', 403, message);

/** Optimistic-concurrency conflict from a store. */
export class StaleWriteError extends Error {
  constructor(id: string, expected: number) {
    super(`${id} was modified concurrently (expected version ${expected})`);
    this.name = 'StaleWriteError';
  }
}
