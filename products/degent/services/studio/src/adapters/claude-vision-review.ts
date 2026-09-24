/**
 * Optional vision-model ArtReview using Claude via the official Anthropic SDK: the same model and
 * request shape as the mint's adapter (claude-opus-5, adaptive thinking, structured json_schema
 * verdict, server-side refusal fallbacks) with the Degent DESIGN rules as the guidelines.
 *
 * Differences from the mint's adapter, by design (ADR-0007 §3):
 * - A skipped check NEVER approves. Images the API cannot take (AVIF, or > 3.7 MB raw so base64 stays
 *   under 5 MB) yield `approved: false, needsHuman: true` and the artwork waits for the house.
 * - Oversized JPEGs go through an optional `Downscaler` first (a pure-JS decode/re-encode injected by
 *   wiring). `jpeg-js` is not in the workspace lockfile, so no downscaler is wired by default and
 *   oversized images are marked needsHuman rather than auto-approved.
 * - Transport/API errors throw: the API maps that to 503 and the artwork stays `submitted` so the
 *   artist can retry the upload. Nobody is rejected because a dependency was down.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ReviewCheck } from '@bsh/degent-mint-sdk';
import { DEGENT_GUIDELINES } from '../domain/guidelines.js';
import type { ArtReview, ArtReviewInput, ReviewVerdict } from '../ports/art-review.js';

export const VISION_REVIEW_MODEL = 'claude-opus-5';
export const MAX_IMAGE_BYTES = 3_700_000;
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type SupportedType = (typeof SUPPORTED)[number];

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'reasons'],
  properties: {
    approved: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** The one SDK call this adapter makes; injectable so tests never touch the network. */
export type BetaMessagesCreate = (
  params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Beta.Messages.BetaMessage>;

/**
 * Re-encodes an image so it fits `maxBytes` (pure JS, no native deps). Returns null when it cannot.
 * The verdict is still about the ORIGINAL bytes: only the model's copy shrinks.
 */
export type Downscaler = (input: { bytes: Uint8Array; contentType: string; maxBytes: number }) => Promise<{ bytes: Uint8Array; contentType: SupportedType } | null>;

export interface ClaudeVisionReviewOptions {
  apiKey?: string;
  create?: BetaMessagesCreate;
  guidelines?: string;
  timeoutMs?: number;
  downscale?: Downscaler;
}

function skipped(detail: string): ReviewVerdict {
  const check: ReviewCheck = { id: 'guidelines', passed: false, detail: `vision review skipped: ${detail}; a house reviewer will look at it` };
  return { approved: false, needsHuman: true, reasons: [], checks: [check] };
}

export class ClaudeVisionReview implements ArtReview {
  readonly name = 'vision';
  private readonly create: BetaMessagesCreate;
  private readonly guidelines: string;
  private readonly downscale: Downscaler | null;

  constructor(opts: ClaudeVisionReviewOptions) {
    if (opts.create) this.create = opts.create;
    else {
      if (!opts.apiKey) throw new Error('ClaudeVisionReview needs an apiKey (VISION_REVIEW_API_KEY) or an injected client');
      const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 });
      this.create = (params) => client.beta.messages.create(params);
    }
    this.guidelines = opts.guidelines ?? DEGENT_GUIDELINES;
    this.downscale = opts.downscale ?? null;
  }

  /** Factory used by config wiring: returns null (disabled) when no key is configured. */
  static fromEnv(apiKey: string | undefined | null, guidelines?: string, downscale?: Downscaler): ClaudeVisionReview | null {
    return apiKey ? new ClaudeVisionReview({ apiKey, ...(guidelines ? { guidelines } : {}), ...(downscale ? { downscale } : {}) }) : null;
  }

  async review(input: ArtReviewInput): Promise<ReviewVerdict> {
    let type = input.declaredContentType.toLowerCase();
    let bytes = input.bytes;
    if (!(SUPPORTED as readonly string[]).includes(type)) return skipped(`${type} is not supported by the model`);
    if (bytes.length > MAX_IMAGE_BYTES) {
      const smaller = this.downscale && type === 'image/jpeg' ? await this.downscale({ bytes, contentType: type, maxBytes: MAX_IMAGE_BYTES }) : null;
      if (!smaller || smaller.bytes.length > MAX_IMAGE_BYTES)
        return skipped(`${bytes.length} bytes exceeds the model image limit and no downscaler could shrink it`);
      bytes = smaller.bytes;
      type = smaller.contentType;
    }

    const response = await this.create({
      model: VISION_REVIEW_MODEL,
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA as unknown as Record<string, unknown> } },
      system: this.guidelines,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: type as SupportedType, data: Buffer.from(bytes).toString('base64') },
            },
            { type: 'text', text: 'Review this submission against the Degent design rules and the guidelines and return the verdict.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      const reason = 'automated review declined this image';
      return { approved: false, needsHuman: false, reasons: [reason], checks: [{ id: 'guidelines', passed: false, detail: reason }] };
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let verdict: { approved: boolean; reasons: string[] };
    try {
      verdict = JSON.parse(text);
      if (typeof verdict.approved !== 'boolean' || !Array.isArray(verdict.reasons)) throw new Error('shape');
    } catch {
      throw new Error(`vision review returned an unparseable verdict (stop_reason=${response.stop_reason})`);
    }
    const reasons = verdict.approved ? [] : verdict.reasons.map(String).slice(0, 10);
    return {
      approved: verdict.approved,
      needsHuman: false,
      reasons,
      checks: [
        {
          id: 'guidelines',
          passed: verdict.approved,
          detail: verdict.approved ? `approved by ${response.model}` : reasons.join('; ') || 'rejected',
        },
      ],
    };
  }
}
