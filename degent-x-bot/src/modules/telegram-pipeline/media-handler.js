const { uploadFile } = require('../../services/storage-client');
const { getDb } = require('../../services/database');
const { telegramMedia } = require('../../db/schema');
const { classifyMedia } = require('./classifier');
const { bridgeToContentQueue } = require('./content-bridge');
const logger = require('../../lib/logger');

async function processMedia(bot, metadata, fileType) {
  try {
    // 1. Download file from Telegram
    const file = await bot.api.getFile(metadata.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // 2. Determine mime type
    const ext = file.file_path?.split('.').pop() || 'jpg';
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', mp4: 'video/mp4', webp: 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    // 3. Upload to S3/R2
    const storedUrl = await uploadFile(buffer, mimeType, 'telegram');

    // 4. Classify with AI (photos only for now)
    let classification = null;
    if (fileType === 'photo') {
      classification = await classifyMedia(buffer, mimeType);
    }

    // 5. Store in database
    const db = getDb();
    const [record] = await db.insert(telegramMedia).values({
      telegramMessageId: metadata.messageId,
      telegramChatId: metadata.chatId,
      telegramUserId: metadata.userId,
      telegramUsername: metadata.username,
      fileType,
      originalFileId: metadata.fileId,
      storedUrl: storedUrl || fileUrl,
      category: classification?.category || 'OTHER',
      qualityScore: classification?.quality_score || 0,
      reactionCount: 0,
      forwardCount: 0,
    }).returning();

    logger.info({
      id: record.id,
      category: classification?.category,
      quality: classification?.quality_score,
      username: metadata.username,
    }, 'Telegram media processed and stored');

    // 6. If quality is high enough, bridge to content queue
    if (classification && classification.quality_score >= 70) {
      await bridgeToContentQueue(record, classification, metadata);
    }

    return record;
  } catch (err) {
    logger.error({ err, metadata }, 'Failed to process Telegram media');
    throw err;
  }
}

module.exports = { processMedia };
