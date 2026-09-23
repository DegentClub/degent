/**
 * Optional vision-model ArtReview using Claude via the official Anthropic SDK.
 * Enabled only when ART_REVIEW_API_KEY is set; never used in tests (a fake client is injected).
 *
 * - Model: claude-opus-5 with adaptive thinking; structured output (json_schema) for the verdict.
 * - Server-side refusal fallbacks enabled (`fallbacks: "default"`); a final `refusal` stop reason
 *   is treated as a rejection ("automated review declined this image").
 * - Images the API cannot take (AVIF, or > ~3.7 MB raw so base64 stays under 5 MB) are not sent;
 *   the verdict then depends on the rules adapter alone and a skipped check is recorded.
 * - Transport/API errors throw: the API maps that to 503 and the order stays `awaiting_content`
 *   so the user can retry the upload. Nobody is rejected because a dependency was down.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ReviewResult } from '@bsh/degent-mint-sdk';
import type { ArtReview, ArtReviewInput } from '../ports/art-review.js';

export const ART_REVIEW_MODEL = 'claude-opus-5';
const MAX_IMAGE_BYTES = 3_700_000;
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type SupportedType = (typeof SUPPORTED)[number];

export const DEFAULT_GUIDELINES = `You review artwork submitted to the degent.club ("Decentralized Gentlemen Club") collection
before it is permanently inscribed on Bitcoin. Approve by default: stylistic range is wide and
taste is not a reason to reject. Reject only if the image clearly contains any of:
1. sexual content involving minors, or any explicit sexual content;
2. graphic real-world violence or gore;
3. hate symbols or content targeting protected groups;
4. personal data (addresses, phone numbers, IDs, private keys, seed phrases) or doxxing;
5. scams: QR codes or text directing people to send funds, fake giveaways, impersonation of brands or people;
6. an essentially blank, solid-colour or pure-noise image with no discernible artwork.
Give short, user-facing reasons for any rejection.`;

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

export interface ClaudeArtReviewOptions {
  apiKey?: string;
  create?: BetaMessagesCreate;
  guidelines?: string;
  timeoutMs?: number;
}

export class ClaudeArtReview implements ArtReview {
  readonly name = 'vision';
  private readonly create: BetaMessagesCreate;
  private readonly guidelines: string;

  constructor(opts: ClaudeArtReviewOptions) {
    if (opts.create) this.create = opts.create;
    else {
      if (!opts.apiKey) throw new Error('ClaudeArtReview needs an apiKey (ART_REVIEW_API_KEY) or an injected client');
      const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 });
      this.create = (params) => client.beta.messages.create(params);
    }
    this.guidelines = opts.guidelines ?? DEFAULT_GUIDELINES;
  }

  /** Factory used by config wiring: returns null (disabled) when no key is configured. */
  static fromEnv(apiKey: string | undefined, guidelines?: string): ClaudeArtReview | null {
    return apiKey ? new ClaudeArtReview({ apiKey, ...(guidelines ? { guidelines } : {}) }) : null;
  }

  async review(input: ArtReviewInput): Promise<ReviewResult> {
    const type = input.declaredContentType.toLowerCase();
    if (!(SUPPORTED as readonly string[]).includes(type) || input.bytes.length > MAX_IMAGE_BYTES) {
      const detail = !(SUPPORTED as readonly string[]).includes(type)
        ? `vision review skipped: ${type} is not supported by the model`
        : `vision review skipped: ${input.bytes.length} bytes exceeds the model image limit`;
      return { approved: true, reasons: [], checks: [{ id: 'guidelines', passed: true, detail }] };
    }

    const response = await this.create({
      model: ART_REVIEW_MODEL,
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
              source: { type: 'base64', media_type: type as SupportedType, data: Buffer.from(input.bytes).toString('base64') },
            },
            { type: 'text', text: 'Review this submission against the guidelines and return the verdict.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      const reason = 'automated review declined this image';
      return { approved: false, reasons: [reason], checks: [{ id: 'guidelines', passed: false, detail: reason }] };
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
