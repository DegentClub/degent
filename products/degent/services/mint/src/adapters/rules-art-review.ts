/**
 * Deterministic ArtReview: re-checks the declared metadata against the collection rules using the
 * REAL bytes (magic-byte type sniffing + header-decoded dimensions), never the client's claims.
 */
import type { CollectionConfig, ReviewCheck, ReviewResult } from '@bsh/degent-mint-sdk';
import { readImageInfo, validateContentMeta } from '@bsh/degent-mint-sdk';
import type { ArtReview, ArtReviewInput } from '../ports/art-review.js';

export class RulesArtReview implements ArtReview {
  readonly name = 'rules';
  constructor(private readonly config: CollectionConfig) {}

  async review(input: ArtReviewInput): Promise<ReviewResult> {
    const info = readImageInfo(input.bytes);
    const checks: ReviewCheck[] = [];
    const declared = input.declaredContentType.toLowerCase();
    checks.push({
      id: 'magic_bytes',
      passed: info !== null && info.contentType === declared,
      detail:
        info === null
          ? 'bytes are not a recognised image (png, jpeg, webp, gif, avif)'
          : info.contentType === declared
            ? `bytes are ${info.contentType}`
            : `bytes are ${info.contentType} but ${input.declaredContentType} was declared`,
    });
    const dimsKnown = info !== null && info.width !== null && info.height !== null;
    checks.push({
      id: 'dimensions_readable',
      passed: dimsKnown,
      detail: dimsKnown ? `${info!.width}x${info!.height}px` : 'could not read image dimensions from the header',
    });
    const meta = validateContentMeta(
      {
        contentType: declared,
        contentLength: input.bytes.length,
        ...(dimsKnown ? { width: info!.width!, height: info!.height! } : {}),
      },
      this.config,
    );
    checks.push(...meta.checks);
    const reasons = checks.filter((c) => !c.passed).map((c) => c.detail);
    return { approved: reasons.length === 0, reasons, checks };
  }
}

/**
 * Runs reviewers in order; stops at the first rejection (no point paying for a vision call on a
 * file the rules already refuse). Checks are namespaced by reviewer.
 */
export class CompositeArtReview implements ArtReview {
  readonly name: string;
  constructor(private readonly reviewers: ArtReview[]) {
    this.name = reviewers.map((r) => r.name).join('+');
  }
  async review(input: ArtReviewInput): Promise<ReviewResult> {
    const checks: ReviewCheck[] = [];
    const reasons: string[] = [];
    for (const r of this.reviewers) {
      const res = await r.review(input);
      checks.push(...res.checks.map((c) => ({ ...c, id: `${r.name}.${c.id}` })));
      reasons.push(...res.reasons);
      if (!res.approved) return { approved: false, reasons, checks };
    }
    return { approved: true, reasons, checks };
  }
}
