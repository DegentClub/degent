/**
 * Art review. Same port shape as the mint's `ArtReview` (name + review(input) -> ReviewResult) so an
 * adapter written for one service drops into the other, but re-implemented here: components share
 * code only through platform/ and contracts/, never by importing each other's internals.
 *
 * The rules review is deterministic and header-only (magic bytes, dimensions, square, size tier).
 * A vision review is optional (`src/adapters/claude-vision-review.ts`) and only enabled with a key.
 */
import { readImageInfo } from './image-info.js';
import { MAX_DIMENSION_PX, MIN_DIMENSION_PX, TIERS, isTier, tierForSize, type Tier } from './domain/tiers.js';

export interface ReviewCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ReviewResult {
  approved: boolean;
  reasons: string[];
  checks: ReviewCheck[];
}

export interface ArtReviewInput {
  /** Correlation id (job / upload id); never the user's session token. */
  refId: string;
  declaredContentType: string;
  bytes: Uint8Array;
  /** When given, the size must land in this tier. */
  tier?: Tier;
}

export interface ArtReview {
  readonly name: string;
  review(input: ArtReviewInput): Promise<ReviewResult>;
}

/** Pure, synchronous version of the rules review for callers that hold the bytes. */
export function reviewRules(input: ArtReviewInput): ReviewResult {
  const info = readImageInfo(input.bytes);
  const declared = input.declaredContentType.toLowerCase().trim();
  const checks: ReviewCheck[] = [];
  checks.push({
    id: 'magic_bytes',
    passed: info !== null && info.contentType === declared,
    detail:
      info === null
        ? 'bytes are not a recognised image (png, jpeg, webp, gif, avif)'
        : info.contentType === declared
          ? `bytes are ${info.contentType}`
          : `bytes are ${info.contentType} but ${declared || '(none)'} was declared`,
  });
  const dims = info !== null && info.width !== null && info.height !== null;
  checks.push({ id: 'dimensions_readable', passed: dims, detail: dims ? `${info!.width}x${info!.height}px` : 'could not read image dimensions from the header' });
  if (dims) {
    const w = info!.width!;
    const h = info!.height!;
    checks.push({ id: 'square', passed: w === h, detail: w === h ? 'square' : `not square (${w}x${h})` });
    for (const [id, v] of [
      ['width', w],
      ['height', h],
    ] as const) {
      const ok = v >= MIN_DIMENSION_PX && v <= MAX_DIMENSION_PX;
      checks.push({ id, passed: ok, detail: `${id} ${v}px ${ok ? 'within' : 'outside'} ${MIN_DIMENSION_PX}-${MAX_DIMENSION_PX}px` });
    }
  }
  const tier = tierForSize(input.bytes.length);
  const min = Math.min(...TIERS.map((t) => t.minBytes));
  const max = Math.max(...TIERS.map((t) => t.maxBytes));
  checks.push({
    id: 'size',
    passed: tier !== null,
    detail: tier ? `${input.bytes.length} bytes fits the ${tier.label} tier (${tier.minBytes}-${tier.maxBytes})` : `${input.bytes.length} bytes is outside ${min}-${max} bytes`,
  });
  if (input.tier !== undefined && isTier(input.tier)) {
    const ok = tier !== null && tier.tier === input.tier;
    checks.push({ id: 'tier', passed: ok, detail: ok ? `size matches the ${input.tier} tier` : `size does not match the ${input.tier} tier (got ${tier?.tier ?? 'none'})` });
  }
  const reasons = checks.filter((c) => !c.passed).map((c) => c.detail);
  return { approved: reasons.length === 0, reasons, checks };
}

export class RulesArtReview implements ArtReview {
  readonly name = 'rules';
  async review(input: ArtReviewInput): Promise<ReviewResult> {
    return reviewRules(input);
  }
}

/** Runs reviewers in order, stops at the first rejection. Checks are namespaced by reviewer. */
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
