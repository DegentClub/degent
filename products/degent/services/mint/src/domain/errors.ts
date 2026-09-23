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

/** Raised by the policy signer. Always logged; never retried automatically. */
export class PolicyViolation extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`policy signer refused: ${violations.join('; ')}`);
    this.name = 'PolicyViolation';
    this.violations = violations;
  }
}

/** Optimistic-concurrency conflict from an OrderStore. */
export class StaleWriteError extends Error {
  constructor(id: string, expected: number) {
    super(`order ${id} was modified concurrently (expected version ${expected})`);
    this.name = 'StaleWriteError';
  }
}
