const { eq, and } = require('drizzle-orm');
const { getDb } = require('../../services/database');
const { getUserTimeline } = require('../../services/twitter-client');
const { trackedAccounts } = require('../../db/schema');
const { evaluateTweet } = require('./evaluator');
const { executeEngagement } = require('./executor');
const logger = require('../../lib/logger');

async function scanTimelines() {
  const db = getDb();

  // Get all active tracked accounts
  const accounts = await db.select().from(trackedAccounts).where(eq(trackedAccounts.isActive, true));

  if (accounts.length === 0) {
    logger.info('No tracked accounts to scan');
    return { scanned: 0, engaged: 0 };
  }

  let totalScanned = 0;
  let totalEngaged = 0;

  for (const account of accounts) {
    try {
      // Check engagement frequency
      if (!shouldEngageNow(account)) continue;

      const tweets = await getUserTimeline(account.twitterUserId, 5);
      totalScanned += tweets.length;

      for (const tweet of tweets) {
        const evaluation = await evaluateTweet(tweet, account);
        if (evaluation && evaluation.action !== 'skip') {
          await executeEngagement(evaluation, tweet, account);
          totalEngaged++;
        }
      }
    } catch (err) {
      logger.error({ err, username: account.username }, 'Error scanning timeline');
    }
  }

  logger.info({ scanned: totalScanned, engaged: totalEngaged }, 'Timeline scan complete');
  return { scanned: totalScanned, engaged: totalEngaged };
}

function shouldEngageNow(account) {
  if (!account.lastEngagedAt) return true;

  const hoursSinceLastEngagement = (Date.now() - new Date(account.lastEngagedAt).getTime()) / (1000 * 3600);

  switch (account.engagementFrequency) {
    case 'daily': return hoursSinceLastEngagement >= 4;
    case '3x_week': return hoursSinceLastEngagement >= 12;
    case 'weekly': return hoursSinceLastEngagement >= 24;
    case 'opportunistic': return hoursSinceLastEngagement >= 8;
    default: return hoursSinceLastEngagement >= 4;
  }
}

module.exports = { scanTimelines };
