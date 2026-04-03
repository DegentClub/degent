const logger = require('../../lib/logger');

// Score and rank AI-generated content candidates
function scoreCandidates(candidates) {
  if (!candidates || candidates.length === 0) return [];

  return candidates
    .map((candidate) => {
      let score = candidate.score || 50;

      const text = candidate.text || '';

      // Boost for optimal length (100-250 chars tend to perform best)
      if (text.length >= 100 && text.length <= 250) score += 5;
      if (text.length < 50) score -= 10;

      // Boost for having a question (drives replies)
      if (text.includes('?')) score += 3;

      // Boost for emoji usage (1-3 emojis is optimal)
      const emojiCount = (text.match(/[\u{1F000}-\u{1FFFF}]/gu) || []).length;
      if (emojiCount >= 1 && emojiCount <= 3) score += 3;
      if (emojiCount > 5) score -= 5;

      // Penalize for too many hashtags
      const hashtagCount = (text.match(/#/g) || []).length;
      if (hashtagCount > 2) score -= 10;

      // Penalize for being over 280 chars
      if (text.length > 280) score -= 20;

      // Boost for including key brand terms naturally
      const lower = text.toLowerCase();
      if (lower.includes('degent') || lower.includes('degent.club')) score += 5;
      if (lower.includes('ordinals') || lower.includes('bitcoin nft')) score += 3;

      // Cap score
      score = Math.max(0, Math.min(100, score));

      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);
}

// Pick the best candidate
function pickBest(candidates) {
  const scored = scoreCandidates(candidates);
  if (scored.length === 0) return null;
  const best = scored[0];
  logger.info({ score: best.score, preview: best.text.slice(0, 80) }, 'Best candidate selected');
  return best;
}

module.exports = { scoreCandidates, pickBest };
