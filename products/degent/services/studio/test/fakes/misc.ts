import type { ReviewCheck } from '@bsh/degent-mint-sdk';
import type { ArtReview, ArtReviewInput, ReviewVerdict } from '../../src/ports/art-review.js';
import type { Clock } from '../../src/ports/clock.js';

export class FakeClock implements Clock {
  private t: number;
  constructor(start = '2026-09-24T12:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

export const approve = (detail = 'approved by fake vision'): ReviewVerdict => ({ approved: true, needsHuman: false, reasons: [], checks: [{ id: 'guidelines', passed: true, detail }] });
export const reject = (...reasons: string[]): ReviewVerdict => ({
  approved: false,
  needsHuman: false,
  reasons,
  checks: [{ id: 'guidelines', passed: false, detail: reasons.join('; ') }],
});
export const needsHuman = (detail = 'vision review skipped: test'): ReviewVerdict => {
  const check: ReviewCheck = { id: 'guidelines', passed: false, detail };
  return { approved: false, needsHuman: true, reasons: [], checks: [check] };
};

/** Stands in for the vision reviewer: scripted verdict, records every call, can throw. */
export class FakeVisionReview implements ArtReview {
  readonly name = 'vision';
  calls: ArtReviewInput[] = [];
  constructor(public result: ReviewVerdict | Error = approve()) {}
  async review(input: ArtReviewInput): Promise<ReviewVerdict> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return structuredClone(this.result);
  }
}
