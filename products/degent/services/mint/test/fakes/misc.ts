import type { ReviewResult } from '@bsh/degent-mint-sdk';
import type { ArtReview, ArtReviewInput } from '../../src/ports/art-review.js';
import type { BroadcastResult, Broadcaster } from '../../src/ports/broadcaster.js';
import type { Clock } from '../../src/ports/clock.js';
import type { FakeChain } from './chain.js';

export class FakeClock implements Clock {
  private t: number;
  constructor(start = '2026-09-23T12:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

/** Captures every hex it is given; pushes to the fake chain unless told to fail. */
export class FakeBroadcaster implements Broadcaster {
  readonly sent: string[] = [];
  mode: 'ok' | 'retryable' | 'permanent' = 'ok';
  constructor(readonly name: string, private readonly chain: FakeChain | null) {}
  async broadcast(txHex: string): Promise<BroadcastResult> {
    this.sent.push(txHex);
    if (this.mode === 'retryable') return { ok: false, error: 'connection refused', retryable: true, via: this.name };
    if (this.mode === 'permanent') return { ok: false, error: 'bad-txns-something', retryable: false, via: this.name };
    try {
      const txid = this.chain ? this.chain.acceptRaw(txHex) : 'f'.repeat(64);
      return { ok: true, txid, via: this.name };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: false, via: this.name };
    }
  }
}

export class FakeArtReview implements ArtReview {
  readonly name = 'fake';
  calls: ArtReviewInput[] = [];
  constructor(public result: ReviewResult | Error = { approved: true, reasons: [], checks: [] }) {}
  async review(input: ArtReviewInput): Promise<ReviewResult> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
