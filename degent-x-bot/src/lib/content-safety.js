const logger = require('./logger');

const DEFAULT_BANNED_WORDS = ['financial advice', 'guaranteed returns', 'pump', 'rug pull'];

function checkSafety(content, options = {}) {
  const bannedWords = options.bannedWords || DEFAULT_BANNED_WORDS;
  const maxHashtags = options.maxHashtags || 2;
  const maxLength = options.maxLength || 280;

  const lower = content.toLowerCase();

  const result = {
    pass: true,
    checks: {
      noFinancialAdvice: !lower.includes('financial advice') && !lower.includes('guaranteed'),
      noWalletAddresses: !/\b(bc1|1[a-zA-Z0-9]{25,34}|3[a-zA-Z0-9]{25,34})\b/.test(content),
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

module.exports = { checkSafety };
