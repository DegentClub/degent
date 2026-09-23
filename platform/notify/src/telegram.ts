import type { EventEnvelope } from '@bsh/events';
import { renderEvent, type DeliveryResult, type Notification, type NotificationChannel, type RenderedMessage, type RetryPolicy } from './types.js';
import type { FetchLike } from './webhook.js';

export type TelegramSendResult = DeliveryResult;

/** Telegram port: send a plain-text message to a chat. */
export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<TelegramSendResult>;
}

export interface HttpTelegramClientOptions {
  /** Bot token from the secret store. Never logged; errors never include the request URL. */
  botToken: string;
  fetch: FetchLike;
  apiBase?: string;
  timeoutMs?: number;
}

/** Bot API adapter (`POST /bot<token>/sendMessage`). 429 honours `parameters.retry_after`. */
export class HttpTelegramClient implements TelegramClient {
  constructor(private readonly o: HttpTelegramClientOptions) {
    if (!o.botToken) throw new Error('telegram bot token required');
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    const url = `${this.o.apiBase ?? 'https://api.telegram.org'}/bot${this.o.botToken}/sendMessage`;
    try {
      const res = await this.o.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      let body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } = {};
      try {
        body = JSON.parse(await res.text());
      } catch {
        /* non-JSON error page */
      }
      if (res.status >= 200 && res.status < 300 && body.ok !== false) return { ok: true, status: res.status };
      const error = `telegram HTTP ${res.status}: ${body.description ?? 'error'}`.replaceAll(this.o.botToken, '***');
      const retryAfter = body.parameters?.retry_after;
      return {
        ok: false,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        error,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { ok: false, retryable: true, error: msg.replaceAll(this.o.botToken, '***') };
    }
  }
}

export class TelegramChannel implements NotificationChannel {
  readonly kind = 'telegram';
  readonly retry: RetryPolicy = { maxAttempts: 6, backoff: { initialMs: 2_000, factor: 2, maxMs: 300_000, jitter: 'equal' } };

  constructor(
    private readonly client: TelegramClient,
    private readonly render: (event: EventEnvelope) => RenderedMessage = (e) => renderEvent(e, 3_500),
  ) {}

  validateTarget(target: string): void {
    if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(target)) throw new Error(`invalid telegram chat id: ${target}`);
  }

  async send(n: Notification): Promise<DeliveryResult> {
    const { subject, text } = this.render(n.event);
    return this.client.sendMessage(n.subscription.target, `${subject}\n\n${text}`);
  }
}
