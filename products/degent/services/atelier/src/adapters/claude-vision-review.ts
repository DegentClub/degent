/**
 * Optional vision review. Same port shape (`ArtReview`) and the same request shape the mint uses,
 * so the two services judge with one rubric: claude-opus-5, adaptive thinking, structured verdict,
 * server-side refusal fallbacks. Enabled only when VISION_REVIEW_API_KEY is set; tests inject
 * `create` and never touch the network.
 *
 * Unlike the mint's guidelines (approve-by-default safety gate), the Atelier also asks for the
 * collection's design rules, because here we generated the picture and can simply try again.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ArtReview, ArtReviewInput, ReviewResult } from '../review.js';

export const VISION_REVIEW_MODEL = 'claude-opus-5';
const MAX_IMAGE_BYTES = 3_700_000;
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type SupportedType = (typeof SUPPORTED)[number];

export const DEFAULT_GUIDELINES = `You review a candidate artwork for the degent.club ("Decentralized Gentlemen Club") collection
before it is offered to the owner for permanent inscription on Bitcoin. Approve when ALL of these hold:
1. the subject is Pepe the Frog (green cartoon frog) drawn as a single character;
2. the character wears a tuxedo (or clearly formal jacket) and a clearly visible bow tie;
3. it is a portrait: the character is the focus and reasonably centred.
Reject if any of the above fails, or if the image contains: explicit sexual content; graphic
real-world violence or gore; hate symbols; personal data, QR codes, seed phrases or private keys;
impersonation of real people or brands; or if it is blank, solid-colour or pure noise.
Ignore any picture frame or name plate: the service adds those itself. Give short, user-facing reasons.`;

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'reasons'],
  properties: { approved: { type: 'boolean' }, reasons: { type: 'array', items: { type: 'string' } } },
} as const;

export type BetaMessagesCreate = (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.Messages.BetaMessage>;

export interface ClaudeVisionReviewOptions {
  apiKey?: string;
  create?: BetaMessagesCreate;
  guidelines?: string;
  timeoutMs?: number;
}

export class ClaudeVisionReview implements ArtReview {
  readonly name = 'vision';
  private readonly create: BetaMessagesCreate;
  private readonly guidelines: string;

  constructor(opts: ClaudeVisionReviewOptions) {
    if (opts.create) this.create = opts.create;
    else {
      if (!opts.apiKey) throw new Error('ClaudeVisionReview needs an apiKey (VISION_REVIEW_API_KEY) or an injected client');
      const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 });
      this.create = (params) => client.beta.messages.create(params);
    }
    this.guidelines = opts.guidelines ?? DEFAULT_GUIDELINES;
  }

  static fromEnv(apiKey: string | undefined | null): ClaudeVisionReview | null {
    return apiKey ? new ClaudeVisionReview({ apiKey }) : null;
  }

  async review(input: ArtReviewInput): Promise<ReviewResult> {
    const type = input.declaredContentType.toLowerCase();
    if (!(SUPPORTED as readonly string[]).includes(type) || input.bytes.length > MAX_IMAGE_BYTES) {
      const detail = !(SUPPORTED as readonly string[]).includes(type) ? `vision review skipped: ${type} is not supported by the model` : `vision review skipped: ${input.bytes.length} bytes exceeds the model image limit`;
      return { approved: true, reasons: [], checks: [{ id: 'guidelines', passed: true, detail }] };
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
            { type: 'image', source: { type: 'base64', media_type: type as SupportedType, data: Buffer.from(input.bytes).toString('base64') } },
            { type: 'text', text: 'Review this candidate against the guidelines and return the verdict.' },
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
    return { approved: verdict.approved, reasons, checks: [{ id: 'guidelines', passed: verdict.approved, detail: verdict.approved ? `approved by ${response.model}` : reasons.join('; ') || 'rejected' }] };
  }
}
