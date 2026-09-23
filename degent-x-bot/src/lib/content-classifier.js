// Approval-tier classifier.
//
// Every piece of outbound content is sorted into one of three tiers before it
// touches the queue:
//
//   'manual'  — financial claims. Never auto-posted. A human writes or
//               approves it and takes responsibility for it.
//   'review'  — factual claims with numbers (mint counts, blockspace,
//               fee levels). Sits in the review queue until approved.
//   'auto'    — memes, gm posts, replies, community banter. Posts on its own
//               when the review queue is switched off.
//
// The rules are deliberately keyword/regex based rather than model based so
// that they are deterministic, testable, and cannot be talked out of a
// decision by a clever prompt.

const TIERS = Object.freeze({ AUTO: 'auto', REVIEW: 'review', MANUAL: 'manual' });
const TIER_RANK = { auto: 0, review: 1, manual: 2 };

// --- manual: anything that reads as a price, return or investment claim -----
const MANUAL_RULES = [
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
];

// --- review: facts with numbers ------------------------------------------
const REVIEW_RULES = [
  { id: 'mint_count', re: /\b\d[\d,]*\s*(?:\/|of)\s*\d[\d,]*\b/ }, // 4,113 of 10,000
  { id: 'minted', re: /\bmint(?:ed|s|ing)?\b/i }, // numeric-gated below
  { id: 'blockspace_size', re: /\b\d+(?:\.\d+)?\s?(?:kb|mb|gb|tb|bytes?|vb|vbytes?)\b/i },
  { id: 'fee_rate', re: /\b\d+(?:\.\d+)?\s?sat(?:s)?\/vb\b/i },
  { id: 'percentage', re: /\b\d+(?:\.\d+)?\s?%/ },
  { id: 'blockspace_fact', re: /\bblockspace\b/i },
  { id: 'partnership', re: /\bpartner(?:ship|ed|ing)?\b|\bcollab(?:oration)?\b/i },
  { id: 'announcement', re: /\bannounc(?:e|es|ed|ing|ement)\b/i },
];

const REPLY_TYPES = new Set(['reply', 'quoteTweet', 'quote_tweet', 'mention']);

function matchRules(rules, text) {
  return rules.filter((r) => r.re.test(text)).map((r) => r.id);
}

/**
 * Classify a piece of content into an approval tier.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.contentType]  'meme' | 'gm' | 'alpha' | 'reply' | ...
 * @returns {{ tier: 'auto'|'review'|'manual', reasons: string[] }}
 */
function classifyContentDetailed(text, opts = {}) {
  const body = typeof text === 'string' ? text : '';
  const contentType = opts.contentType;

  const manual = matchRules(MANUAL_RULES, body);
  if (manual.length > 0) {
    return { tier: TIERS.MANUAL, reasons: manual };
  }

  const review = matchRules(REVIEW_RULES, body);
  // Numeric facts only escalate to review when there is actually a number.
  const hasNumber = /\d/.test(body);
  const reviewReasons = review.filter((id) => {
    if (id === 'blockspace_fact' || id === 'minted') return hasNumber;
    return true;
  });

  if (reviewReasons.length > 0) {
    return { tier: TIERS.REVIEW, reasons: reviewReasons };
  }

  if (contentType && REPLY_TYPES.has(contentType)) {
    return { tier: TIERS.AUTO, reasons: ['reply'] };
  }

  return { tier: TIERS.AUTO, reasons: [] };
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @returns {'auto'|'review'|'manual'}
 */
function classifyContent(text, opts = {}) {
  return classifyContentDetailed(text, opts).tier;
}

/**
 * Return the more restrictive of two tiers.
 */
function maxTier(a, b) {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

module.exports = {
  classifyContent,
  classifyContentDetailed,
  maxTier,
  TIERS,
  MANUAL_RULES,
  REVIEW_RULES,
};
