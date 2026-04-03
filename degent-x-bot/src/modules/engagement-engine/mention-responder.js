const { getMentions, postTweet } = require('../../services/twitter-client');
const { generateReply } = require('../content-engine');
const { canExecute, recordUsage } = require('../../lib/rate-limiter');
const { checkSafety } = require('../../lib/content-safety');
const { getRedis } = require('../../services/redis-client');
const logger = require('../../lib/logger');

const REPLIED_KEY_PREFIX = 'mention:replied:';

async function respondToMentions() {
  try {
    const mentions = await getMentions(20);
    if (!mentions || mentions.length === 0) {
      logger.debug('No new mentions');
      return { responded: 0 };
    }

    const redis = getRedis();
    let responded = 0;

    for (const mention of mentions) {
      // Skip if already replied
      const replyKey = `${REPLIED_KEY_PREFIX}${mention.id}`;
      const alreadyReplied = await redis.get(replyKey);
      if (alreadyReplied) continue;

      // Rate limit check
      if (!(await canExecute('POST /tweets'))) {
        logger.warn('Rate limit reached, stopping mention responses');
        break;
      }

      try {
        // Generate a contextual reply
        const reply = await generateReply(
          mention.author_id || 'someone',
          mention.text || ''
        );

        if (!reply || !reply.text) continue;

        const safety = checkSafety(reply.text);
        if (!safety.pass) {
          logger.warn({ failures: safety.failures }, 'Mention reply failed safety');
          continue;
        }

        await postTweet(reply.text, { replyToTweetId: mention.id });
        await recordUsage('POST /tweets');

        // Mark as replied (expire in 7 days)
        await redis.set(replyKey, '1', 'EX', 7 * 24 * 3600);
        responded++;

        logger.info({ mentionId: mention.id }, 'Responded to mention');
      } catch (err) {
        logger.error({ err, mentionId: mention.id }, 'Failed to respond to mention');
      }
    }

    logger.info({ responded, total: mentions.length }, 'Mention response cycle complete');
    return { responded };
  } catch (err) {
    logger.error({ err }, 'Failed to process mentions');
    return { responded: 0 };
  }
}

module.exports = { respondToMentions };
