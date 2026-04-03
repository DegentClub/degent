const { generateJSON } = require('../../services/ai-client');
const logger = require('../../lib/logger');

async function evaluateTweet(tweet, account) {
  const tweetText = tweet.text || '';
  const metrics = tweet.public_metrics || {};

  // Quick filter: skip very old tweets (> 24h)
  if (tweet.created_at) {
    const tweetAge = Date.now() - new Date(tweet.created_at).getTime();
    if (tweetAge > 24 * 3600 * 1000) return { action: 'skip', reason: 'too old' };
  }

  // Quick filter: skip low-engagement tweets from tier 3
  if (account.tier === 3 && (metrics.like_count || 0) < 5) {
    return { action: 'skip', reason: 'low engagement tier 3' };
  }

  const prompt = `Evaluate this tweet for engagement by @degentclub (a Bitcoin Ordinals NFT project).

Tweet by @${account.username} (Tier ${account.tier}, Category: ${account.category || 'general'}):
"${tweetText}"

Tweet metrics: ${JSON.stringify(metrics)}

Decide the best engagement action:
- "like" — just like it (low effort, broad engagement)
- "retweet" — retweet it (only if very relevant to our audience)
- "reply" — reply with a witty/valuable comment
- "quote_tweet" — quote tweet with our take
- "skip" — not worth engaging with

Consider:
1. Relevance to Bitcoin/Ordinals/NFT space (0-100)
2. Engagement opportunity (can we add value or get visibility?)
3. Account tier: Tier 1 = always engage, Tier 3 = only if high opportunity

Return JSON: {"action": "like|retweet|reply|quote_tweet|skip", "reason": "...", "relevance_score": 0-100, "reply_text": "..." }
If action is reply or quote_tweet, include reply_text (max 280 chars).`;

  try {
    const result = await generateJSON(prompt, { maxTokens: 512 });
    if (result.parsed) {
      logger.info({
        action: result.parsed.action,
        username: account.username,
        relevance: result.parsed.relevance_score,
      }, 'Tweet evaluated');
      return result.parsed;
    }
    return { action: 'skip', reason: 'evaluation parse failure' };
  } catch (err) {
    logger.error({ err }, 'Tweet evaluation failed');
    return { action: 'skip', reason: 'evaluation error' };
  }
}

module.exports = { evaluateTweet };
