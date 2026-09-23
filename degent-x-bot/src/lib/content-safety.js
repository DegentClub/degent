const logger = require('./logger');
const { containsBitcoinAddress } = require('./bitcoin-address');
const { classifyContentDetailed, TIERS } = require('./content-classifier');

const DEFAULT_BANNED_WORDS = ['financial advice', 'guaranteed returns', 'pump', 'rug pull'];

const NFA_SUFFIX = 'NFA.';
const NFA_REGEX = /\bNFA\b|\bnot financial advice\b/i;
const MAX_TWEET_LENGTH = 280;

function checkSafety(content, options = {}) {
  const bannedWords = options.bannedWords || DEFAULT_BANNED_WORDS;
  const maxHashtags = options.maxHashtags || 2;
  const maxLength = options.maxLength || MAX_TWEET_LENGTH;

  const lower = content.toLowerCase();

  const result = {
    pass: true,
    checks: {
      noFinancialAdvice: !lower.includes('financial advice') && !lower.includes('guaranteed'),
      noWalletAddresses: !containsBitcoinAddress(content),
      noBannedWords: !bannedWords.some((w) => lower.includes(w.toLowerCase())),
      noExcessiveHashtags: (content.match(/#/g) || []).length <= maxHashtags,
      withinCharLimit: content.length <= maxLength,
      notEmpty: content.trim().length > 0,
    },
    failures: [],
  };

  for (const [check, passed] of Object.entries(result.checks)) {
    if (!passed) {
      result.pass = false;
      result.failures.push(check);
    }
  }

  if (!result.pass) {
    logger.warn({ failures: result.failures, contentPreview: content.slice(0, 100) }, 'Content safety check failed');
  }

  return result;
}

/**
 * Decide whether content of a given tier may be posted without a human.
 *
 *   manual -> never
 *   review -> never (must be approved through the queue)
 *   auto   -> only when the review queue is disabled
 */
function canAutoPost(tier, { reviewQueueEnabled }) {
  if (tier === TIERS.MANUAL) return false;
  if (tier === TIERS.REVIEW) return false;
  return reviewQueueEnabled === false;
}

/**
 * Append an "NFA." disclaimer where it is allowed and useful.
 *
 * Rules:
 *   - manual tier: never. A disclaimer does not launder a price claim; the
 *     content is blocked from auto-posting regardless.
 *   - review tier: append when the text discusses market-ish topics and the
 *     result still fits in a tweet.
 *   - auto tier: leave untouched.
 *   - never duplicate an existing NFA / "not financial advice".
 *
 * @returns {{ text: string, appended: boolean }}
 */
function appendDisclaimer(text, tier) {
  const body = typeof text === 'string' ? text.trimEnd() : '';
  if (tier !== TIERS.REVIEW) return { text: body, appended: false };
  if (NFA_REGEX.test(body)) return { text: body, appended: false };

  const marketish = /\b(?:blockspace|mint|fees?|sat\/vb|accumulat|market|sales?|whale)\w*/i.test(body);
  if (!marketish) return { text: body, appended: false };

  const candidate = `${body} ${NFA_SUFFIX}`;
  if (candidate.length > MAX_TWEET_LENGTH) return { text: body, appended: false };
  return { text: candidate, appended: true };
}

/**
 * Full gate for generated content. Classifies, applies the disclaimer, and
 * decides the queue status.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.contentType]
 * @param {boolean} opts.reviewQueueEnabled
 * @returns {{ tier, reasons, text, status: 'approved'|'pending', autoPost: boolean, safety }}
 */
function gateContent(text, opts) {
  const { tier, reasons } = classifyContentDetailed(text, { contentType: opts.contentType });
  const { text: finalText } = appendDisclaimer(text, tier);
  const safety = checkSafety(finalText);
  const autoPost = safety.pass && canAutoPost(tier, { reviewQueueEnabled: opts.reviewQueueEnabled });
  return {
    tier,
    reasons,
    text: finalText,
    status: autoPost ? 'approved' : 'pending',
    autoPost,
    safety,
  };
}

module.exports = {
  checkSafety,
  canAutoPost,
  appendDisclaimer,
  gateContent,
  NFA_SUFFIX,
  MAX_TWEET_LENGTH,
};
