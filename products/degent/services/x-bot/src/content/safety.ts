/**
 * Content safety and the posting gate. `gateContent` is the single decision point every draft passes through:
 * classify -> disclaimer (review tier only) -> safety checks -> may it post without a human?
 */
import { containsBitcoinAddress } from './bitcoin-address.js';
import { classifyContentDetailed, TIERS, type Tier } from './classifier.js';

export const DEFAULT_BANNED_WORDS: readonly string[] = ['financial advice', 'guaranteed returns', 'pump', 'rug pull'];
export const NFA_SUFFIX = 'NFA.';
const NFA_REGEX = /\bNFA\b|\bnot financial advice\b/i;
export const MAX_TWEET_LENGTH = 280;

export interface SafetyChecks {
  noFinancialAdvice: boolean;
  noWalletAddresses: boolean;
  noBannedWords: boolean;
  noExcessiveHashtags: boolean;
  withinCharLimit: boolean;
  notEmpty: boolean;
}

export interface SafetyResult {
  pass: boolean;
  checks: SafetyChecks;
  failures: Array<keyof SafetyChecks>;
}

export interface SafetyOptions {
  bannedWords?: readonly string[];
  maxHashtags?: number;
  maxLength?: number;
}

export function checkSafety(content: string, options: SafetyOptions = {}): SafetyResult {
  const bannedWords = options.bannedWords ?? DEFAULT_BANNED_WORDS;
  const maxHashtags = options.maxHashtags ?? 2;
  const maxLength = options.maxLength ?? MAX_TWEET_LENGTH;
  const lower = content.toLowerCase();
  const checks: SafetyChecks = {
    noFinancialAdvice: !lower.includes('financial advice') && !lower.includes('guaranteed'),
    noWalletAddresses: !containsBitcoinAddress(content),
    noBannedWords: !bannedWords.some((w) => lower.includes(w.toLowerCase())),
    noExcessiveHashtags: (content.match(/#/g) ?? []).length <= maxHashtags,
    withinCharLimit: content.length <= maxLength,
    notEmpty: content.trim().length > 0,
  };
  const failures = (Object.keys(checks) as Array<keyof SafetyChecks>).filter((k) => !checks[k]);
  return { pass: failures.length === 0, checks, failures };
}

/**
 * May content of this tier post without a human?  manual -> never; review -> never (approve it in the queue);
 * auto -> only when the review queue is explicitly disabled (`false`, not merely unset).
 */
export function canAutoPost(tier: Tier, opts: { reviewQueueEnabled?: boolean }): boolean {
  if (tier === TIERS.MANUAL || tier === TIERS.REVIEW) return false;
  return opts.reviewQueueEnabled === false;
}

/**
 * Append "NFA." where it is allowed and useful: review tier only, market-ish text only, never twice, never past
 * 280 characters. Manual tier never gets one: a disclaimer does not launder a price claim.
 */
export function appendDisclaimer(text: unknown, tier: Tier): { text: string; appended: boolean } {
  const body = typeof text === 'string' ? text.trimEnd() : '';
  if (tier !== TIERS.REVIEW) return { text: body, appended: false };
  if (NFA_REGEX.test(body)) return { text: body, appended: false };
  const marketish = /\b(?:blockspace|mint|fees?|sat\/vb|accumulat|market|sales?|whale)\w*/i.test(body);
  if (!marketish) return { text: body, appended: false };
  const candidate = `${body} ${NFA_SUFFIX}`;
  if (candidate.length > MAX_TWEET_LENGTH) return { text: body, appended: false };
  return { text: candidate, appended: true };
}

export interface GateDecision {
  tier: Tier;
  reasons: string[];
  /** The text to store/post (with a disclaimer where one applies). */
  text: string;
  status: 'approved' | 'pending';
  autoPost: boolean;
  safety: SafetyResult;
}

/** Classify, apply the disclaimer, check safety, and decide whether the content may post without a human. */
export function gateContent(text: string, opts: { contentType?: string; reviewQueueEnabled?: boolean }): GateDecision {
  const { tier, reasons } = classifyContentDetailed(text, opts.contentType === undefined ? {} : { contentType: opts.contentType });
  const { text: finalText } = appendDisclaimer(text, tier);
  const safety = checkSafety(finalText);
  const autoPost = safety.pass && canAutoPost(tier, { reviewQueueEnabled: opts.reviewQueueEnabled });
  return { tier, reasons, text: finalText, status: autoPost ? 'approved' : 'pending', autoPost, safety };
}
