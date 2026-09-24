/**
 * Approval-tier classifier. Every piece of outbound content is sorted into one of three tiers:
 *
 *   manual  financial claims (price, floor, returns, multipliers, tokens, "at completion"). Never auto-posted;
 *           a human writes or approves it and takes responsibility. A disclaimer does not unlock it.
 *   review  factual claims with numbers (mint counts, sizes, fee rates, percentages), partnerships, announcements.
 *           Waits for a human in the review queue.
 *   auto    memes, gm posts, replies, banter. May post on its own only when the review queue is switched off.
 *
 * Deliberately keyword/regex based rather than model based: deterministic, testable, and it cannot be talked out
 * of a decision by a clever prompt (brain/BRAIN.md, CONTENT APPROVAL TIERS).
 */
export const TIERS = Object.freeze({ AUTO: 'auto', REVIEW: 'review', MANUAL: 'manual' } as const);
export type Tier = (typeof TIERS)[keyof typeof TIERS];
const TIER_RANK: Record<Tier, number> = { auto: 0, review: 1, manual: 2 };

export interface Rule {
  id: string;
  re: RegExp;
}

export const MANUAL_RULES: readonly Rule[] = Object.freeze([
  { id: 'dollar_amount', re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[kmb]|million|billion|thousand)?\b/i },
  { id: 'dollar_word', re: /\b\d[\d,.]*\s?(?:dollars|usd)\b/i },
  { id: 'floor', re: /\bfloor\b/i },
  { id: 'price', re: /\bprices?\b|\bpriced\b|\brepric(?:e|es|ed|ing)\b/i },
  { id: 'multiplier', re: /\b\d+(?:\.\d+)?x\b/i }, // 178x, 2.5x
  { id: 'will_multiply', re: /\bwill\s+\d+x\b/i },
  { id: 'guaranteed', re: /\bguarantee[ds]?\b/i },
  { id: 'roi', re: /\broi\b/i },
  { id: 'invest', re: /\binvest(?:ing|ment|ments|or|ors|ed)?\b/i },
  { id: 'at_completion', re: /\bat completion\b/i },
  { id: 'appreciation', re: /\bappreciat(?:e|es|ed|ion)\b/i },
  { id: 'valuation', re: /\bvaluation\b|\bmarket cap\b|\bmcap\b/i },
  { id: 'returns', re: /\breturns?\b(?!\s+to\b)/i },
  { id: 'profit', re: /\bprofits?\b|\bgains?\b/i },
  { id: 'financial_advice', re: /\bfinancial advice\b/i },
  { id: 'moon_promise', re: /\b(?:will|gonna|going to)\s+(?:moon|pump|10x|100x)\b/i },
  { id: 'token', re: /\$[A-Z]{3,6}\b|\btoken launch\b|\bairdrop\b/ },
]);

export const REVIEW_RULES: readonly Rule[] = Object.freeze([
  { id: 'mint_count', re: /\b\d[\d,]*\s*(?:\/|of)\s*\d[\d,]*\b/ }, // 4,113 of 10,000
  { id: 'minted', re: /\bmint(?:ed|s|ing)?\b/i }, // numeric-gated below
  { id: 'blockspace_size', re: /\b\d+(?:\.\d+)?\s?(?:kb|mb|gb|tb|bytes?|vb|vbytes?)\b/i },
  { id: 'fee_rate', re: /\b\d+(?:\.\d+)?\s?sat(?:s)?\/vb\b/i },
  { id: 'percentage', re: /\b\d+(?:\.\d+)?\s?%/ },
  { id: 'blockspace_fact', re: /\bblockspace\b/i }, // numeric-gated below
  { id: 'partnership', re: /\bpartner(?:ship|ed|ing)?\b|\bcollab(?:oration)?\b/i },
  { id: 'announcement', re: /\bannounc(?:e|es|ed|ing|ement)\b/i },
]);

const NUMERIC_GATED = new Set(['blockspace_fact', 'minted']);
export const REPLY_TYPES: ReadonlySet<string> = new Set(['reply', 'quoteTweet', 'quote_tweet', 'mention']);

export interface Classification {
  tier: Tier;
  /** Ids of the rules that decided (or ['reply'] for a clean reply). */
  reasons: string[];
}

const matchRules = (rules: readonly Rule[], text: string): string[] => rules.filter((r) => r.re.test(text)).map((r) => r.id);

export function classifyContentDetailed(text: unknown, opts: { contentType?: string } = {}): Classification {
  const body = typeof text === 'string' ? text : '';
  const manual = matchRules(MANUAL_RULES, body);
  if (manual.length > 0) return { tier: TIERS.MANUAL, reasons: manual };

  // Numeric facts only escalate to review when there is actually a number.
  const hasNumber = /\d/.test(body);
  const review = matchRules(REVIEW_RULES, body).filter((id) => !NUMERIC_GATED.has(id) || hasNumber);
  if (review.length > 0) return { tier: TIERS.REVIEW, reasons: review };

  if (opts.contentType && REPLY_TYPES.has(opts.contentType)) return { tier: TIERS.AUTO, reasons: ['reply'] };
  return { tier: TIERS.AUTO, reasons: [] };
}

export function classifyContent(text: unknown, opts: { contentType?: string } = {}): Tier {
  return classifyContentDetailed(text, opts).tier;
}

/** The more restrictive of two tiers. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
