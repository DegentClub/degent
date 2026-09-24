/**
 * The slice of the Telegram Bot API the gate uses. Adapters: `GrammyTelegramApi` (production),
 * `MemoryTelegramApi` (tests, regtest dev). The service never sees grammY types.
 */
export interface CreateInviteOptions {
  /** Always 1: a link admits exactly one person. */
  memberLimit: 1;
  /** Unix seconds. */
  expireDate: number;
  /** Shown to admins in the group's invite list, e.g. `gate:<tg id>`. */
  name: string;
}

export interface TelegramApi {
  createInviteLink(chatId: string, opts: CreateInviteOptions): Promise<{ inviteLink: string }>;
  banChatMember(chatId: string, userId: number): Promise<void>;
  unbanChatMember(chatId: string, userId: number, opts: { onlyIfBanned: boolean }): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<void>;
}
