import type { EventEnvelope } from '@bsh/events';
import { renderEvent, type DeliveryResult, type Notification, type NotificationChannel, type RenderedMessage, type RetryPolicy } from './types.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Providers that support it (SES, Postmark, ...) should de-duplicate on this. */
  idempotencyKey: string;
}

/** Email provider port (SES / Postmark / SMTP adapters live in the deploying service). Throw to fail. */
export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/** Thrown by an `EmailSender` for failures that retrying cannot fix (bad address, suppressed recipient). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export class EmailChannel implements NotificationChannel {
  readonly kind = 'email';
  readonly retry: RetryPolicy = { maxAttempts: 5, backoff: { initialMs: 30_000, factor: 2, maxMs: 1_800_000, jitter: 'equal' } };

  constructor(
    private readonly sender: EmailSender,
    private readonly render: (event: EventEnvelope) => RenderedMessage = (e) => renderEvent(e, 20_000),
  ) {}

  validateTarget(target: string): void {
    if (!EMAIL.test(target)) throw new Error(`invalid email address: ${target}`);
  }

  async send(n: Notification): Promise<DeliveryResult> {
    const { subject, text } = this.render(n.event);
    try {
      await this.sender.send({ to: n.subscription.target, subject, text, idempotencyKey: n.idempotencyKey });
      return { ok: true };
    } catch (e) {
      return { ok: false, retryable: !(e instanceof PermanentEmailError), error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Dev adapter: logs instead of sending and keeps what it "sent" for inspection. */
export class ConsoleEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log: (line: string) => void = (l) => console.info(l)) {}
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
    this.log(`[email:dev] to=${msg.to} subject=${JSON.stringify(msg.subject)} key=${msg.idempotencyKey}\n${msg.text}`);
  }
}
