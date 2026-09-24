/**
 * Deterministic ArtReview: re-checks the declared metadata against the collection rules using the
 * REAL bytes (magic-byte type sniffing + header-decoded dimensions), never the client's claims.
 * It also fills the advisory `rules.square` exactly from the dimensions; the design and framing rules
 * need eyes and stay `unknown` here (the vision reviewer fills them). Advisory rules never reject.
 */
import type { CollectionConfig, ReviewCheck, ReviewResult } from '@bsh/degent-mint-sdk';
import { mergeRuleAdvice, readImageInfo, squareRuleAdvice, unknownRuleAdvice, validateContentMeta } from '@bsh/degent-mint-sdk';
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
    const sq = squareRuleAdvice(dimsKnown ? info!.width : null, dimsKnown ? info!.height : null);
    const rules = unknownRuleAdvice('needs the vision review (not configured or not reached)');
    rules.square = sq.square;
    rules.notes.square = sq.note;
    return { approved: reasons.length === 0, reasons, checks, rules };
  }
}

/**
 * Runs reviewers in order; stops at the first rejection (no point paying for a vision call on a
 * file the rules already refuse). Checks are namespaced by reviewer. Advisory `rules` are merged
 * (`mergeRuleAdvice`): per rule the earliest reviewer with a pass/fail wins, so the deterministic
 * reviewer's exact `square` beats a model's estimate.
 */
export class CompositeArtReview implements ArtReview {
  readonly name: string;
  constructor(private readonly reviewers: ArtReview[]) {
    this.name = reviewers.map((r) => r.name).join('+');
  }
  async review(input: ArtReviewInput): Promise<ReviewResult> {
    const checks: ReviewCheck[] = [];
    const reasons: string[] = [];
    const advice: Array<ReviewResult['rules']> = [];
    const result = (approved: boolean): ReviewResult => {
      const rules = mergeRuleAdvice(...advice);
      return rules ? { approved, reasons, checks, rules } : { approved, reasons, checks };
    };
    for (const r of this.reviewers) {
      const res = await r.review(input);
      checks.push(...res.checks.map((c) => ({ ...c, id: `${r.name}.${c.id}` })));
      reasons.push(...res.reasons);
      advice.push(res.rules);
      if (!res.approved) return result(false);
    }
    return result(true);
  }
}
