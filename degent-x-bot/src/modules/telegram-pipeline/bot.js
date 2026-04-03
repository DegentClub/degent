const { Bot } = require('grammy');
const config = require('../../config');
const logger = require('../../lib/logger');
const { processMedia } = require('./media-handler');

let bot = null;

function startBot() {
  if (!config.telegram.botToken) {
    logger.warn('Telegram bot token not configured, skipping Telegram pipeline');
    return null;
  }

  bot = new Bot(config.telegram.botToken);

  // Monitor group for photos
  bot.on('message:photo', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const targetChatId = config.telegram.groupChatId;

      // Only process messages from the configured group
      if (targetChatId && chatId !== targetChatId) return;

      const photo = ctx.message.photo;
      const largest = photo[photo.length - 1]; // Get highest resolution

      const metadata = {
        messageId: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        username: ctx.from?.username || ctx.from?.first_name || 'anonymous',
        caption: ctx.message.caption || '',
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
      };

      logger.info({ username: metadata.username, messageId: metadata.messageId }, 'New photo in Telegram group');
      await processMedia(bot, metadata, 'photo');
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram photo');
    }
  });

  // Monitor for videos/GIFs
  bot.on('message:video', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const targetChatId = config.telegram.groupChatId;
      if (targetChatId && chatId !== targetChatId) return;

      const video = ctx.message.video;
      const metadata = {
        messageId: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        username: ctx.from?.username || ctx.from?.first_name || 'anonymous',
        caption: ctx.message.caption || '',
        fileId: video.file_id,
        fileUniqueId: video.file_unique_id,
      };

      logger.info({ username: metadata.username }, 'New video in Telegram group');
      await processMedia(bot, metadata, 'video');
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram video');
    }
  });

  // Monitor for animations (GIFs)
  bot.on('message:animation', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const targetChatId = config.telegram.groupChatId;
      if (targetChatId && chatId !== targetChatId) return;

      const anim = ctx.message.animation;
      const metadata = {
        messageId: ctx.message.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        username: ctx.from?.username || ctx.from?.first_name || 'anonymous',
        caption: ctx.message.caption || '',
        fileId: anim.file_id,
        fileUniqueId: anim.file_unique_id,
      };

      logger.info({ username: metadata.username }, 'New GIF in Telegram group');
      await processMedia(bot, metadata, 'gif');
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram GIF');
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  bot.start();
  logger.info('Telegram bot started');
  return bot;
}

function stopBot() {
  if (bot) {
    bot.stop();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

module.exports = { startBot, stopBot };
