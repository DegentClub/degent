const { eq, and } = require('drizzle-orm');
const { generateTweet, getContentTypeForTimeSlot } = require('../../content-engine');
const { postTweet, uploadMedia } = require('../../../services/twitter-client');
const { canExecute, recordUsage } = require('../../../lib/rate-limiter');
const { recordContent } = require('../../../lib/deduplicator');
const { getDb } = require('../../../services/database');
const { contentQueue } = require('../../../db/schema');
const config = require('../../../config');
const logger = require('../../../lib/logger');

async function handlePostContent(job) {
  if (!config.features.autoPostEnabled) {
    logger.info('Auto-posting disabled, skipping');
    return { skipped: true, reason: 'disabled' };
  }

  const db = getDb();

  // 1. Check if there's approved content waiting in the queue
  const approved = await db.select()
    .from(contentQueue)
    .where(
      and(
        eq(contentQueue.status, 'approved'),
      )
    )
    .limit(1);

  let contentToPost = null;

  if (approved.length > 0) {
    contentToPost = approved[0];
    logger.info({ id: contentToPost.id, type: contentToPost.contentType }, 'Found approved content in queue');
  } else {
    // 2. Generate new content
    const contentType = job.data?.contentType || getContentTypeForTimeSlot();
    logger.info({ contentType }, 'Generating new content');

    const generated = await generateTweet(contentType, job.data?.context || {});
    if (!generated) {
      logger.warn('Content generation returned nothing');
      return { skipped: true, reason: 'generation_failed' };
    }

    // Insert into queue
    const [record] = await db.insert(contentQueue).values({
      contentType,
      source: job.data?.manual ? 'manual' : 'ai_generated',
      status: 'approved',
      textContent: generated.text,
      aiModel: generated.model,
      aiPromptUsed: generated.prompt,
      contentScore: generated.score,
      approvalTier: 'auto',
    }).returning();

    contentToPost = record;
  }

  // 3. Rate limit check
  if (!(await canExecute('POST /tweets'))) {
    logger.warn('Rate limit reached for tweets, re-queuing');
    return { skipped: true, reason: 'rate_limit' };
  }

  // 4. Post to Twitter
  try {
    const options = {};

    // Upload media if present
    if (contentToPost.mediaUrls && contentToPost.mediaUrls.length > 0) {
      const mediaIds = [];
      for (const url of contentToPost.mediaUrls) {
        try {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const mediaId = await uploadMedia(buffer);
          mediaIds.push(mediaId);
        } catch (err) {
          logger.error({ err, url }, 'Failed to upload media');
        }
      }
      if (mediaIds.length > 0) {
        options.mediaIds = mediaIds;
      }
    }

    const result = await postTweet(contentToPost.textContent, options);
    await recordUsage('POST /tweets');

    // Record for dedup
    await recordContent(result.id, contentToPost.textContent);

    // 5. Update queue record
    await db.update(contentQueue)
      .set({
        status: 'posted',
        postedAt: new Date(),
        tweetId: result.id,
        tweetUrl: `https://x.com/degentclub/status/${result.id}`,
        updatedAt: new Date(),
      })
      .where(eq(contentQueue.id, contentToPost.id));

    logger.info({
      tweetId: result.id,
      contentType: contentToPost.contentType,
      preview: contentToPost.textContent?.slice(0, 80),
    }, 'Content posted to X');

    return { posted: true, tweetId: result.id };
  } catch (err) {
    // Mark as failed
    await db.update(contentQueue)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(contentQueue.id, contentToPost.id));

    logger.error({ err }, 'Failed to post content');
    throw err;
  }
}

module.exports = { handlePostContent };
