/** In-memory TelegramApi: records every call; `failNext` makes the next call of a method throw (like a Bot API error). */
import type { CreateInviteOptions, TelegramApi } from '../ports/telegram-api.js';

type Method = 'createInviteLink' | 'banChatMember' | 'unbanChatMember' | 'sendMessage';

export class MemoryTelegramApi implements TelegramApi {
  readonly invites: Array<{ chatId: string; opts: CreateInviteOptions; inviteLink: string }> = [];
  readonly bans: Array<{ chatId: string; userId: number }> = [];
  readonly unbans: Array<{ chatId: string; userId: number; onlyIfBanned: boolean }> = [];
  readonly messages: Array<{ chatId: number; text: string }> = [];
  private readonly failures = new Map<Method, string[]>();

  failNext(method: Method, message = `Telegram API error in ${method}`): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), message]);
  }

  private maybeFail(method: Method): void {
    const queue = this.failures.get(method);
    const msg = queue?.shift();
    if (msg !== undefined) throw new Error(msg);
  }

  async createInviteLink(chatId: string, opts: CreateInviteOptions): Promise<{ inviteLink: string }> {
    this.maybeFail('createInviteLink');
    const inviteLink = `https://t.me/+invite${this.invites.length + 1}`;
    this.invites.push({ chatId, opts, inviteLink });
    return { inviteLink };
  }

  async banChatMember(chatId: string, userId: number): Promise<void> {
    this.maybeFail('banChatMember');
    this.bans.push({ chatId, userId });
  }

  async unbanChatMember(chatId: string, userId: number, opts: { onlyIfBanned: boolean }): Promise<void> {
    this.maybeFail('unbanChatMember');
    this.unbans.push({ chatId, userId, onlyIfBanned: opts.onlyIfBanned });
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.maybeFail('sendMessage');
    this.messages.push({ chatId, text });
  }
}
