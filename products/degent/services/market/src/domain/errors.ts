/** Domain errors carrying an API error code (MarketErrorCode) and HTTP status. Messages are safe to show users. */
import type { MarketErrorCode } from '@bsh/degent-market-sdk';

export class DomainError extends Error {
  readonly code: MarketErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: MarketErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string) => new DomainError('not_found', 404, `${what} not found`);
export const invalid = (message: string, details?: unknown) => new DomainError('validation_failed', 422, message, details);

/** Raised by the settlement engine: a transaction the service must not hand out or broadcast. */
export class SettlementError extends DomainError {
  constructor(code: MarketErrorCode, message: string, details?: unknown) {
    super(code, 400, message, details);
    this.name = 'SettlementError';
  }
}

/** Optimistic-concurrency conflict from a ListingStore. */
export class StaleWriteError extends Error {
  constructor(id: string, expected: number) {
    super(`listing ${id} was modified concurrently (expected version ${expected})`);
    this.name = 'StaleWriteError';
  }
}
