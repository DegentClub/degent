import { signWebhookPayload, SIGNATURE_HEADER } from './signature.js';
import type { DeliveryResult, Notification, NotificationChannel, NotificationSubscription, RetryPolicy } from './types.js';

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  redirect?: 'manual' | 'follow' | 'error';
}) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Resolves the signing secret(s) for a subscription: the current secret first, then any still-accepted previous
 * secrets during rotation. Values come from the secret store; subscriptions only carry ids.
 */
export type WebhookSecretResolver = (sub: NotificationSubscription & { id: string }) => Promise<string | readonly string[]>;

export interface WebhookChannelOptions {
  fetch: FetchLike;
  secrets: WebhookSecretResolver;
  /** Unix-seconds clock for the signature timestamp (tests). */
  nowSec?: () => number;
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** Allow `http:` targets (dev only). */
  allowHttp?: boolean;
  /** Allow localhost / private-range literal IP targets (dev only). Hostnames are the egress proxy's job. */
  allowPrivateHosts?: boolean;
  userAgent?: string;
}

export const WEBHOOK_HEADERS = {
  signature: SIGNATURE_HEADER,
  idempotencyKey: 'Idempotency-Key',
  eventId: 'Bsh-Event-Id',
  eventType: 'Bsh-Event-Type',
  attempt: 'Bsh-Delivery-Attempt',
} as const;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

export function validateWebhookTarget(target: string, opts: { allowHttp?: boolean; allowPrivateHosts?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`webhook target is not a URL: ${target}`);
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) throw new Error('webhook target must use https');
  if (url.username || url.password) throw new Error('webhook target must not embed credentials');
  if (!opts.allowPrivateHosts && PRIVATE_HOST.test(url.hostname)) throw new Error(`webhook target host ${url.hostname} is private`);
  return url;
}

/** Statuses worth retrying: timeouts, rate limits, server errors. Other 4xx mean the receiver rejected it. */
export const isRetryableStatus = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;

function retryAfterMs(h: string | null, nowMs: number): number | undefined {
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * POSTs the CloudEvents envelope as JSON, signed with `Bsh-Signature: t=…,v1=…`.
 * 2xx = delivered; 408/425/429/5xx and network errors/timeouts = retryable (honouring `Retry-After`);
 * other statuses = permanent failure. Redirects are not followed (a moved endpoint must be re-registered).
 */
export class WebhookChannel implements NotificationChannel {
  readonly kind = 'webhook';
  readonly retry: RetryPolicy;

  constructor(private readonly o: WebhookChannelOptions) {
    this.retry = o.retry ?? { maxAttempts: 8, backoff: { initialMs: 1_000, factor: 3, maxMs: 3_600_000, jitter: 'equal' } };
  }

  validateTarget(target: string): void {
    validateWebhookTarget(target, this.o);
  }

  async send(n: Notification): Promise<DeliveryResult> {
    const body = JSON.stringify(n.event);
    const nowSec = this.o.nowSec?.() ?? Math.floor(Date.now() / 1000);
    let secrets: string | readonly string[];
    try {
      this.validateTarget(n.subscription.target);
      secrets = await this.o.secrets(n.subscription);
    } catch (e) {
      return { ok: false, retryable: false, error: e instanceof Error ? e.message : String(e) };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/cloudevents+json; charset=utf-8',
      'User-Agent': this.o.userAgent ?? 'bsh-notify/0.1',
      [WEBHOOK_HEADERS.signature]: signWebhookPayload(body, secrets, nowSec),
      [WEBHOOK_HEADERS.idempotencyKey]: n.idempotencyKey,
      [WEBHOOK_HEADERS.eventId]: n.event.id,
      [WEBHOOK_HEADERS.eventType]: n.event.type,
      [WEBHOOK_HEADERS.attempt]: String(n.attempt),
    };
    try {
      const res = await this.o.fetch(n.subscription.target, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
        redirect: 'manual',
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const retryable = isRetryableStatus(res.status);
      const ra = retryAfterMs(res.headers.get('retry-after'), nowSec * 1000);
      return { ok: false, retryable, status: res.status, error: `HTTP ${res.status}`, ...(ra !== undefined ? { retryAfterMs: ra } : {}) };
    } catch (e) {
      return { ok: false, retryable: true, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  }
}
