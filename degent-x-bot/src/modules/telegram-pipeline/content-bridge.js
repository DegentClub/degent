const { getDb } = require('../../services/database');
const { contentQueue } = require('../../db/schema');
const logger = require('../../lib/logger');
const config = require('../../config');
const { gateContent } = require('../../lib/content-safety');
const { maxTier } = require('../../lib/content-classifier');

async function bridgeToContentQueue(mediaRecord, classification, metadata) {
  try {
    const db = getDb();

    // Generate tweet text: use AI suggestion or create a default
    let tweetText = classification.suggested_tweet_text;
    if (!tweetText) {
      tweetText = `s/o to ${metadata.username} in the TG for this absolute gem 🔥\n\nDegent community never misses`;
    }

    // Determine approval tier based on category
    let approvalTier = 'review';
    if (['MEME', 'FAN_ART', 'COMMUNITY'].includes(classification.category)) {
      approvalTier = 'auto';
    }
    if (classification.category === 'SCREENSHOT') {
      // Whale alerts get faster approval
      approvalTier = classification.quality_score >= 85 ? 'auto' : 'review';
    }

    // The caption itself can carry price talk — classify it and take the
    // stricter of the category tier and the text tier.
    const gate = gateContent(tweetText, {
      contentType: 'repost',
      reviewQueueEnabled: config.features.reviewQueueEnabled,
    });
    approvalTier = maxTier(approvalTier, gate.tier);
    tweetText = gate.text;
    const status = approvalTier === 'auto' && gate.autoPost ? 'approved' : 'pending';

    const [record] = await db.insert(contentQueue).values({
      contentType: 'repost',
      source: 'telegram',
      status,
      textContent: tweetText,
      mediaUrls: mediaRecord.storedUrl ? [mediaRecord.storedUrl] : [],
      telegramMessageId: metadata.messageId,
      telegramUser: metadata.username,
      telegramUsername: metadata.username,
      telegramEngagementScore: classification.quality_score,
      contentScore: classification.quality_score,
      approvalTier,
    }).returning();

    logger.info({
      contentId: record.id,
      approvalTier,
      category: classification.category,
    }, 'Telegram content bridged to content queue');

    return record;
  } catch (err) {
    logger.error({ err }, 'Failed to bridge Telegram content to queue');
    throw err;
  }
}

module.exports = { bridgeToContentQueue };
