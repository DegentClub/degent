/**
 * The published degent.club Minting Rules as data (site spec, "Mint process": four check-marked cards,
 * with card 1 split into its two independent checks), so the studio, the mint and the front end
 * render and enforce the same list. `check` says who verifies a rule:
 *   - `automated`: decided from the bytes alone (`validateContentMeta` with `DEGENT_RULES_CONFIG`,
 *     `readImageInfo`);
 *   - `vision`: needs a vision model or a human looking at the picture;
 *   - `both`: automated pre-check plus a look at the picture.
 * The machine-readable twin is contracts/schemas/degent-rules.json (asserted equal in tests).
 */
import type { CollectionConfig } from './types.js';
import { DEFAULT_CONFIG, FULLBLOCK_MAX_BYTES, STANDARD_MIN_BYTES, recommendedContentType } from './rules.js';

export const DEGENT_RULES_VERSION = '1.0.0';

export type DegentRuleCheck = 'automated' | 'vision' | 'both';

export interface DegentRule {
  /** Stable id, also used as check id prefix in review results. */
  id: 'format' | 'square' | 'design' | 'framing' | 'quantity';
  title: string;
  /** The published wording. */
  text: string;
  check: DegentRuleCheck;
}

export const DEGENT_RULES: readonly DegentRule[] = Object.freeze([
  {
    id: 'format',
    title: 'File format & size',
    text: `JPEG recommended (PNG, WebP, AVIF and GIF accepted), at least ${STANDARD_MIN_BYTES / 1000} KB and at most ${FULLBLOCK_MAX_BYTES / 1_000_000} MB; the size picks the tier.`,
    check: 'automated',
  },
  {
    id: 'square',
    title: 'Square',
    text: `Square image (width equals height), ${DEFAULT_CONFIG.minDimensionPx}-${DEFAULT_CONFIG.maxDimensionPx} px a side.`,
    check: 'automated',
  },
  {
    id: 'design',
    title: 'Essential design',
    text: 'Pepe character wearing a tuxedo with a mandatory bowtie.',
    check: 'vision',
  },
  {
    id: 'framing',
    title: 'Framing & text',
    text: 'Must be framed and include a placard that says "DEGEN", "DEGENT", or "REGEN".',
    check: 'vision',
  },
  {
    id: 'quantity',
    title: 'Quantity',
    text: 'Mint as many as you want - create your own mini-collection! No per-wallet cap.',
    check: 'automated',
  },
]) as readonly DegentRule[];

/** The words a placard may carry (rule `framing`), exactly as the site publishes them. */
export const DEGENT_PLACARD_WORDS: readonly string[] = Object.freeze(['DEGEN', 'DEGENT', 'REGEN']);

/**
 * DEFAULT_CONFIG with the square rule switched on: what the studio validates submissions against.
 * The mint keeps DEFAULT_CONFIG (no square check) until it adopts the rule in its own contract.
 */
export const DEGENT_RULES_CONFIG: CollectionConfig = Object.freeze({ ...DEFAULT_CONFIG, requireSquare: true }) as CollectionConfig;

export { recommendedContentType as DEGENT_RECOMMENDED_CONTENT_TYPE };
