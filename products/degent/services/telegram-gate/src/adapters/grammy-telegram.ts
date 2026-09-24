/**
 * grammY adapters: the TelegramApi port over `bot.api`, and the DM bot that answers /start and /verify.
 * The command handlers are plain functions (`onStart`, `onVerify`) so they are tested without a network.
 */
import { Bot, type Api } from 'grammy';
import type { GateService } from '../application/gate-service.js';
import type { Logger } from '../application/logger.js';
import { GateError } from '../domain/errors.js';
import { MESSAGES } from '../domain/messages.js';
import type { CreateInviteOptions, TelegramApi } from '../ports/telegram-api.js';

export class GrammyTelegramApi implements TelegramApi {
  constructor(private readonly api: Api) {}

  async createInviteLink(chatId: string, opts: CreateInviteOptions): Promise<{ inviteLink: string }> {
    const link = await this.api.createChatInviteLink(chatId, { member_limit: opts.memberLimit, expire_date: opts.expireDate, name: opts.name });
    return { inviteLink: link.invite_link };
  }

  async banChatMember(chatId: string, userId: number): Promise<void> {
    await this.api.banChatMember(chatId, userId);
  }

  async unbanChatMember(chatId: string, userId: number, opts: { onlyIfBanned: boolean }): Promise<void> {
    await this.api.unbanChatMember(chatId, userId, { only_if_banned: opts.onlyIfBanned });
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  }
}

export interface CommandInput {
  chatType: string | undefined;
  fromId: number | undefined;
}

export function onStart(input: CommandInput): string | null {
  return input.chatType === 'private' ? MESSAGES.start : null;
}

/** The reply to /verify: the one-time link in a DM, a pointer to the DM in a group, a refusal otherwise. */
export async function onVerify(input: CommandInput, service: Pick<GateService, 'startVerification'>, log: Logger): Promise<string> {
  if (input.chatType !== 'private') return MESSAGES.dmOnly;
  try {
    return (await service.startVerification(input.fromId)).text;
  } catch (e) {
    if (e instanceof GateError) return e.message;
    log.error('gate: /verify failed', { telegramUserId: input.fromId, error: e instanceof Error ? e.message : String(e) });
    return MESSAGES.failed;
  }
}

export function createGateBot(token: string, getService: () => Pick<GateService, 'startVerification'>, log: Logger): Bot {
  const bot = new Bot(token);
  bot.command('start', async (ctx) => {
    const text = onStart({ chatType: ctx.chat?.type, fromId: ctx.from?.id });
    if (text) await ctx.reply(text);
  });
  bot.command('verify', async (ctx) => {
    const text = await onVerify({ chatType: ctx.chat?.type, fromId: ctx.from?.id }, getService(), log);
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  });
  bot.catch((err) => log.error('gate: bot error', { error: err.error instanceof Error ? err.error.message : String(err.error) }));
  return bot;
}
