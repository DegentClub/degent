// grammY bot for the gate: answers /verify in private chats.

const { Bot } = require('grammy');
const { GateError } = require('./service');

function createGateBot({ token, getService, logger }) {
  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await ctx.reply('Send /verify to prove you hold a Degent and receive your invite to the holders group.');
  });

  bot.command('verify', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('DM me /verify — verification happens in private.');
      return;
    }
    const telegramUserId = ctx.from?.id;
    try {
      const { text } = await getService().startVerification(telegramUserId);
      await ctx.reply(text, { link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (err instanceof GateError) {
        await ctx.reply(err.message);
        return;
      }
      logger.error({ err, telegramUserId }, 'gate: /verify failed');
      await ctx.reply('Something went wrong. Try again in a minute.');
    }
  });

  bot.catch((err) => logger.error({ err: err.error }, 'gate: bot error'));

  // Thin adapter the service uses so it never touches grammY directly.
  const telegram = {
    createChatInviteLink: (chatId, opts) => bot.api.createChatInviteLink(chatId, opts),
    banChatMember: (chatId, userId) => bot.api.banChatMember(chatId, userId),
    unbanChatMember: (chatId, userId, opts) => bot.api.unbanChatMember(chatId, userId, opts),
    sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } }),
  };

  return { bot, telegram };
}

module.exports = { createGateBot };
