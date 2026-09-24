/** Test harness: the production graph (createApp + AtelierService) with in-memory adapters and a fake provider. */
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import { MemoryContentStore } from '../../src/adapters/content-store.js';
import { MemoryStateStore, type StateStore } from '../../src/adapters/state-store.js';
import { AtelierService, type Clock, type Quotas } from '../../src/application/atelier-service.js';
import { FakeImageProvider } from '../../src/providers/fake.js';
import type { ImageProvider } from '../../src/providers/image-provider.js';
import { RulesArtReview, type ArtReview } from '../../src/review.js';

export class TestClock implements Clock {
  constructor(public t = Date.parse('2026-09-24T12:00:00Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** RequestInit that also takes raw bytes (TS's BodyInit wants an ArrayBuffer-backed view) and a client IP. */
export type ReqInit = Omit<RequestInit, 'body'> & { body?: BodyInit | Uint8Array | null; ip?: string };

export interface Harness {
  app: Hono;
  service: AtelierService;
  state: StateStore & MemoryStateStore;
  content: MemoryContentStore;
  clock: TestClock;
  provider: ImageProvider;
  /** app.request with an optional client IP (the TCP peer, as @hono/node-server would provide it). */
  req(path: string, init?: ReqInit): Promise<Response>;
  session(ip?: string): Promise<string>;
}

export function makeHarness(opts: {
  provider?: ImageProvider;
  quotas?: Partial<Quotas>;
  candidateReview?: ArtReview | null;
  outputReview?: ArtReview;
  rateLimitPerMinute?: number;
  sessionRateLimitPerMinute?: number;
  corsOrigins?: string[];
} = {}): Harness {
  const clock = new TestClock();
  const state = new MemoryStateStore();
  const content = new MemoryContentStore();
  const provider = opts.provider ?? new FakeImageProvider({ costCents: 4 });
  const service = new AtelierService({
    provider,
    candidateReview: opts.candidateReview ?? null,
    outputReview: opts.outputReview ?? new RulesArtReview(),
    content,
    state,
    clock,
    quotas: { sessionDailyImages: 8, globalDailyCostCents: 1000, sessionsPerIpPerDay: 20, sessionTtlHours: 24, ...opts.quotas },
  });
  const app = createApp({
    service,
    corsOrigins: opts.corsOrigins ?? ['https://degent.club'],
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 1000,
    sessionRateLimitPerMinute: opts.sessionRateLimitPerMinute ?? 1000,
    now: () => clock.t,
  });
  const req = (path: string, init: ReqInit = {}) => {
    const { ip, ...rest } = init;
    return Promise.resolve(app.request(path, rest as RequestInit, { incoming: { socket: { remoteAddress: ip ?? '198.51.100.7' } } }));
  };
  const session = async (ip?: string) => {
    const res = await req('/v1/sessions', { method: 'POST', ...(ip ? { ip } : {}) });
    if (res.status !== 201) throw new Error(`session: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { token: string }).token;
  };
  return { app, service, state, content, clock, provider, req, session };
}

export const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
export const jsonInit = (token: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: auth(token, { 'content-type': 'application/json' }),
  body: JSON.stringify(body),
});
