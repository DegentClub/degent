import type { ReviewResult } from '@bsh/degent-mint-sdk';

export interface ArtReviewInput {
  artworkId: string;
  declaredContentType: string;
  bytes: Uint8Array;
}

/**
 * A reviewer's verdict: the mint SDK's `ReviewResult` plus `needsHuman`. A reviewer that could not
 * look (unsupported type, oversized image, no model configured) returns `approved: false,
 * needsHuman: true` with an explanatory check; it never approves what it did not check.
 */
export interface ReviewVerdict extends ReviewResult {
  needsHuman: boolean;
}

/**
 * Automated guideline check run ONCE at upload (ADR-0007 §3). Same port shape as the mint service's
 * `ArtReview` (name + review(input)), widened with `needsHuman`. The rules adapter is deterministic;
 * the vision-model adapter is optional and only enabled when an API key is configured.
 */
export interface ArtReview {
  readonly name: string;
  review(input: ArtReviewInput): Promise<ReviewVerdict>;
}
