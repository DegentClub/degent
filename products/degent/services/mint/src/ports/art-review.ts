import type { ReviewResult } from '@bsh/degent-mint-sdk';

export interface ArtReviewInput {
  orderId: string;
  declaredContentType: string;
  bytes: Uint8Array;
}

/**
 * Automated guideline check run BEFORE payment (ADR-0002 §5). The rules adapter is deterministic;
 * the vision-model adapter is optional and only enabled when an API key is configured.
 */
export interface ArtReview {
  readonly name: string;
  review(input: ArtReviewInput): Promise<ReviewResult>;
}
