/** Fake transports for @bsh/notify's real channels: a webhook receiver (fetch) and a Telegram client. */
import type { FetchLike, TelegramClient, TelegramSendResult } from '@bsh/notify';

export interface ReceivedWebhook {
  url: string;
  headers: Record<string, string>;
  /** The raw body, exactly as sent (verify signatures on this). */
  body: string;
  json: { type: string; id: string; source: string; subject?: string; data: Record<string, unknown> } & Record<string, unknown>;
}

/**
 * Answers every POST with `status` (default 200), or throws when `fail` is an Error. `attempts` records every
 * request that reached it; `received` only the acknowledged (2xx) ones.
 */
export class FakeWebhookReceiver {
  readonly attempts: ReceivedWebhook[] = [];
  readonly received: ReceivedWebhook[] = [];
  status = 200;
  fail: Error | null = null;

  readonly fetch: FetchLike = async (url, init) => {
    if (this.fail) throw this.fail;
    const req: ReceivedWebhook = { url, headers: { ...init.headers }, body: init.body, json: JSON.parse(init.body) };
    this.attempts.push(req);
    const status = this.status;
    if (status >= 200 && status < 300) this.received.push(req);
    return { status, headers: { get: () => null }, text: async () => '' };
  };
}

export class FakeTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  result: TelegramSendResult = { ok: true, status: 200 };
  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    this.sent.push({ chatId, text });
    return this.result;
  }
}
