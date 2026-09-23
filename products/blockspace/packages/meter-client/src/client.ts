/**
 * Typed client for the public block.space Meter API. Zero dependencies: uses the platform `fetch`
 * (Node >= 22, browsers, workers) or one you inject.
 *
 * Behaviour:
 * - Every call is a GET and is retried on network errors, per-attempt timeouts and HTTP
 *   408/425/429/500/502/503/504, with capped exponential backoff and full jitter. `Retry-After`
 *   (seconds or HTTP date) is honoured, capped at `backoff.maxMs`.
 * - A caller `AbortSignal` cancels the in-flight attempt and any pending backoff sleep; the
 *   resulting abort error is rethrown as-is (never wrapped, never retried).
 * - Every 2xx body is validated against the documented shape. Drift throws `MeterContractError`
 *   immediately (no retry, no partial data).
 */
import { MeterContractError, MeterError, MeterHttpError, MeterNetworkError, MeterTimeoutError } from './errors.js';
import { validate, type Guard } from './guards.js';
import * as S from './schemas.js';
import type {
  BlockDetail,
  Book,
  Denom,
  FrontierResponse,
  GrowthResponse,
  LandmarksResponse,
  MeterResponse,
  ProtocolsResponse,
  SummaryResponse,
  TokenDetailRow,
  TokensResponse,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://block.space';

export interface RetryInfo {
  endpoint: string;
  /** The attempt that just failed (1-based). */
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface MeterClientOptions {
  /** Default `https://block.space`. */
  baseUrl?: string;
  /** Injected fetch (tests, custom agents). Default: `globalThis.fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Per-attempt timeout. Default 15,000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2 (3 attempts total). */
  retries?: number;
  /** Backoff: delay = random() * min(maxMs, baseMs * 2^(attempt-1)). Default 250 / 5,000 ms. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Injected for tests. Must reject with the signal's reason when aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests. Default `Math.random`. */
  random?: () => number;
  /** Extra request headers (e.g. a `user-agent` on the server side). */
  headers?: Record<string, string>;
  onRetry?: (info: RetryInfo) => void;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface TokensQuery {
  book?: Book;
  denom?: Denom;
  sort?: string;
  protocol?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

function assertInt(name: string, v: number, min: number): void {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`);
}

class AttemptTimeout extends Error {}

export class MeterClient {
  readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly headers: Record<string, string>;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(opts: MeterClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const f = opts.fetch ?? (globalThis.fetch as MeterClientOptions['fetch']);
    if (!f) throw new Error('MeterClient: no fetch implementation available; pass options.fetch');
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.baseMs = opts.backoff?.baseMs ?? 250;
    this.maxMs = opts.backoff?.maxMs ?? 5_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.headers = { accept: 'application/json', ...opts.headers };
    this.onRetry = opts.onRetry;
    assertInt('timeoutMs', this.timeoutMs, 1);
    assertInt('retries', this.retries, 0);
  }

  // ---- endpoints ---------------------------------------------------------------------------

  /** `GET /api/tokens`: tokens ranked by attributed blockspace. */
  tokens(query: TokensQuery = {}, o?: CallOptions): Promise<TokensResponse> {
    if (query.limit !== undefined) assertInt('limit', query.limit, 1);
    if (query.offset !== undefined) assertInt('offset', query.offset, 0);
    return this.get('/api/tokens', S.tokensResponse, { ...query }, o);
  }

  /** `GET /api/token/<protocol>/<ref>`: one token, flat row. */
  token(protocol: string, ref: string, o?: CallOptions): Promise<TokenDetailRow> {
    if (!protocol || !ref) throw new RangeError('protocol and ref are required');
    return this.get(`/api/token/${encodeURIComponent(protocol)}/${encodeURIComponent(ref)}`, S.tokenDetailRow, undefined, o);
  }

  /** `GET /api/protocols?book=&denom=`: per-protocol totals. */
  protocols(book: Book = 'a', denom: Denom = 'bytes', o?: CallOptions): Promise<ProtocolsResponse> {
    return this.get('/api/protocols', S.protocolsResponse, { book, denom }, o);
  }

  /** `GET /api/growth?bucket=`: chain growth series bucketed by height. */
  growth(bucket = 1000, o?: CallOptions): Promise<GrowthResponse> {
    assertInt('bucket', bucket, 1);
    return this.get('/api/growth', S.growthResponse, { bucket }, o);
  }

  /** `GET /api/meter`: index progress and chain tip. */
  meter(o?: CallOptions): Promise<MeterResponse> {
    return this.get('/api/meter', S.meterResponse, undefined, o);
  }

  /** `GET /api/frontier`: indexer cursors. */
  frontier(o?: CallOptions): Promise<FrontierResponse> {
    return this.get('/api/frontier', S.frontierResponse, undefined, o);
  }

  /** `GET /api/summary`: whole-chain totals. Heavy on the server; expect occasional 5xx. */
  summary(o?: CallOptions): Promise<SummaryResponse> {
    return this.get('/api/summary', S.summaryResponse, undefined, o);
  }

  /** `GET /api/landmarks`: notable heights. */
  landmarks(o?: CallOptions): Promise<LandmarksResponse> {
    return this.get('/api/landmarks', S.landmarksResponse, undefined, o);
  }

  /** `GET /api/block/<height>`: one block's ledger, attribution and protocol split. */
  block(height: number, o?: CallOptions): Promise<BlockDetail> {
    assertInt('height', height, 0);
    return this.get(`/api/block/${height}`, S.blockDetail, undefined, o);
  }

  // ---- transport ---------------------------------------------------------------------------

  private url(path: string, params?: Record<string, string | number | undefined | null>): string {
    const u = new URL(this.baseUrl + path);
    if (params)
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  private backoffMs(attempt: number, retryAfterMs: number | null): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** (attempt - 1));
    const jittered = Math.floor(this.random() * exp);
    return retryAfterMs === null ? jittered : Math.min(this.maxMs, Math.max(retryAfterMs, jittered));
  }

  private async get<T>(
    endpoint: string,
    guard: Guard<unknown>,
    params: Record<string, string | number | undefined | null> | undefined,
    o: CallOptions | undefined,
  ): Promise<T> {
    const url = this.url(endpoint, params);
    const signal = o?.signal;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      let failure: MeterError;
      let retryAfter: number | null = null;
      try {
        const res = await this.attempt(url, signal);
        const body = await readBody(res);
        if (res.ok) {
          const issues = validate(guard, body);
          if (issues.length) throw new MeterContractError(endpoint, issues, body);
          return body as T;
        }
        const msg =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status} for ${endpoint}`;
        failure = new MeterHttpError(msg, endpoint, attempt, res.status, body);
        if (!RETRY_STATUS.has(res.status)) throw failure;
        retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      } catch (err) {
        if (err instanceof MeterContractError || err instanceof MeterHttpError) throw err;
        if (signal?.aborted) throw signal.reason;
        failure =
          err instanceof AttemptTimeout
            ? new MeterTimeoutError(endpoint, attempt, this.timeoutMs)
            : new MeterNetworkError(
                `network error calling ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
                endpoint,
                attempt,
                err,
              );
      }
      if (attempt > this.retries) throw failure;
      const delayMs = this.backoffMs(attempt, retryAfter);
      this.onRetry?.({ endpoint, attempt, delayMs, reason: failure.message });
      await this.sleep(delayMs, signal);
    }
  }

  /** One fetch bounded by the per-attempt timeout and the caller's signal. */
  private async attempt(url: string, outer?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const onOuter = () => ctl.abort(outer!.reason);
    outer?.addEventListener('abort', onOuter, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort(new AttemptTimeout());
    }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers, signal: ctl.signal });
      // Buffer the body while the deadline is still armed: a server that sends headers and then
      // stalls must time out too.
      const buf = await res.arrayBuffer();
      const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
      return new Response(nullBody ? null : buf, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (err) {
      if (timedOut) throw new AttemptTimeout();
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
