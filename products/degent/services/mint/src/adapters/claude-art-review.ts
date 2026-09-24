/**
 * Optional vision-model ArtReview using Claude via the official Anthropic SDK.
 * Enabled only when ART_REVIEW_API_KEY is set; never used in tests (a fake client is injected).
 *
 * - Model: ART_REVIEW_MODEL with adaptive thinking; structured output (json_schema, VERDICT_SCHEMA) for the
 *   verdict, re-validated client-side (`parseVisionVerdict`).
 * - The verdict has two parts: the hard safety verdict (`approved`/`reasons`, unchanged categories) and the
 *   ADVISORY minting-rules check (`rules`: design, framing, placard text), which never rejects.
 * - Server-side refusal fallbacks enabled (`fallbacks: "default"`); a final `refusal` stop reason
 *   is treated as a rejection ("automated review declined this image"); a `max_tokens` stop throws (retryable).
 * - Images the API cannot take (AVIF, or > ~3.7 MB raw so base64 stays under 5 MB) are not sent;
 *   the verdict then depends on the rules adapter alone and a skipped check is recorded.
 * - Transport/API errors throw: the API maps that to 503 and the order stays `awaiting_content`
 *   so the user can retry the upload. Nobody is rejected because a dependency was down.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MintingRulesAdvice, PlacardText, ReviewResult, RuleVerdict } from '@bsh/degent-mint-sdk';
import { MINTING_RULES, PLACARD_TEXTS, unknownRuleAdvice } from '@bsh/degent-mint-sdk';
import type { ArtReview, ArtReviewInput } from '../ports/art-review.js';

export const ART_REVIEW_MODEL = 'claude-opus-5';
const MAX_IMAGE_BYTES = 3_700_000;
const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type SupportedType = (typeof SUPPORTED)[number];

const RULES_VERBATIM = MINTING_RULES.map((r, i) => `${i + 1}. ${r.title}: "${r.text}"`).join('\n');

export const DEFAULT_GUIDELINES = `You review artwork submitted to the degent.club ("Decentralized Gentlemen Club") collection
before it is permanently inscribed on Bitcoin. You return two separate things.

A. The hard verdict ("approved", "reasons"). Approve by default: stylistic range is wide and
taste is not a reason to reject. Reject only if the image clearly contains any of:
1. sexual content involving minors, or any explicit sexual content;
2. graphic real-world violence or gore;
3. hate symbols or content targeting protected groups;
4. personal data (addresses, phone numbers, IDs, private keys, seed phrases) or doxxing;
5. scams: QR codes or text directing people to send funds, fake giveaways, impersonation of brands or people;
6. an essentially blank, solid-colour or pure-noise image with no discernible artwork.
Give short, user-facing reasons for any rejection.

B. The advisory "rules" check. The club's Minting Rules, verbatim:
${RULES_VERBATIM}
Rules 1 and 4 are checked elsewhere; assess rules 2 and 3 only:
- pepeInTuxWithBowtie: "pass" if a Pepe character wears a tuxedo and a bowtie, "fail" if the image clearly
  does not show that (say what is missing), "unknown" if you cannot tell.
- framedWithPlacard: "pass" if the artwork is framed and carries a placard, "fail" if either is clearly missing,
  "unknown" if you cannot tell.
- placardText: the placard's text when it reads DEGEN, DEGENT or REGEN (ignore case), otherwise "none".
Each note is one short sentence for the collector and the members who vote on the piece.
The advisory rules are information for humans: a failed rule is never a reason to set "approved" to false.`;

const VERDICTS = ['pass', 'fail', 'unknown'] as const;
const PLACARD_CHOICES = [...PLACARD_TEXTS, 'none'] as const;
const RULE = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'note'],
  properties: { verdict: { type: 'string', enum: VERDICTS }, note: { type: 'string' } },
} as const;

/** Structured-output schema of the vision verdict (and what `parseVisionVerdict` enforces client-side). */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'reasons', 'rules'],
  properties: {
    approved: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
    rules: {
      type: 'object',
      additionalProperties: false,
      required: ['pepeInTuxWithBowtie', 'framedWithPlacard', 'placardText'],
      properties: {
        pepeInTuxWithBowtie: RULE,
        framedWithPlacard: RULE,
        placardText: { type: 'string', enum: PLACARD_CHOICES },
      },
    },
  },
} as const;

export interface VisionVerdict {
  approved: boolean;
  reasons: string[];
  rules: {
    pepeInTuxWithBowtie: { verdict: RuleVerdict; note: string };
    framedWithPlacard: { verdict: RuleVerdict; note: string };
    placardText: PlacardText | 'none';
  };
}

const NOTE_MAX = 200;
const clip = (s: string) => (s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX - 1)}…` : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/**
 * Parse and validate the model's JSON against VERDICT_SCHEMA. Structured outputs should guarantee the shape;
 * this is the client-side check the SDK guidance asks for (and what a truncated or off-schema reply hits).
 * Throws on any mismatch; the caller maps that to a retryable 503, never to a rejection.
 */
export function parseVisionVerdict(text: string): VisionVerdict {
  const fail = (why: string): never => {
    throw new Error(`verdict does not match the schema: ${why}`);
  };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (!isObj(v) || !onlyKeys(v, ['approved', 'reasons', 'rules'])) return fail('top level');
  if (typeof v.approved !== 'boolean') fail('approved');
  if (!Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === 'string')) fail('reasons');
  const rules = v.rules;
  if (!isObj(rules) || !onlyKeys(rules, ['pepeInTuxWithBowtie', 'framedWithPlacard', 'placardText'])) return fail('rules');
  for (const id of ['pepeInTuxWithBowtie', 'framedWithPlacard'] as const) {
    const r = rules[id];
    if (!isObj(r) || !onlyKeys(r, ['verdict', 'note']) || !(VERDICTS as readonly unknown[]).includes(r.verdict) || typeof r.note !== 'string')
      fail(`rules.${id}`);
  }
  if (!(PLACARD_CHOICES as readonly unknown[]).includes(rules.placardText)) fail('rules.placardText');
  return v as unknown as VisionVerdict;
}

/** Map the model's advisory answer onto the contract shape (square is measured by the rules reviewer). */
function toAdvice(r: VisionVerdict['rules']): MintingRulesAdvice {
  return {
    square: 'unknown',
    pepeInTuxWithBowtie: r.pepeInTuxWithBowtie.verdict,
    framedWithPlacard: r.framedWithPlacard.verdict,
    placardText: r.placardText === 'none' ? null : r.placardText,
    notes: {
      square: 'measured from the image header by the rules review',
      pepeInTuxWithBowtie: clip(r.pepeInTuxWithBowtie.note),
      framedWithPlacard: clip(r.framedWithPlacard.note),
    },
  };
}

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
      return { approved: true, reasons: [], checks: [{ id: 'guidelines', passed: true, detail }], rules: unknownRuleAdvice(detail) };
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
      const category = response.stop_details?.category;
      return {
        approved: false,
        reasons: [reason],
        checks: [{ id: 'guidelines', passed: false, detail: category ? `${reason} (${category})` : reason }],
        rules: unknownRuleAdvice('not assessed: the automated review declined this image'),
      };
    }
    if (response.stop_reason === 'max_tokens')
      throw new Error('vision review was cut off (stop_reason=max_tokens); retry the upload');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let verdict: VisionVerdict;
    try {
      verdict = parseVisionVerdict(text);
    } catch (e) {
      throw new Error(`vision review returned an unparseable verdict (stop_reason=${response.stop_reason}): ${(e as Error).message}`);
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
      rules: toAdvice(verdict.rules),
    };
  }
}
