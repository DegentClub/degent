/**
 * Typed fetch client for the degent.club marketplace API (contracts/openapi/degent-market.yaml).
 * Browser and Node 22 (global fetch); inject `fetch` for tests. Errors surface as `ApiError`
 * (re-used from the mint SDK so a front end handles both services the same way).
 */
import { ApiError, type FetchLike } from '@bsh/degent-mint-sdk';
import type {
  ApiErrorBody,
  BuyPrepareRequest,
  BuyPrepareResponse,
  BuySubmitRequest,
  BuySubmitResponse,
  CancelListingRequest,
  ChallengeRequest,
  ChallengeResponse,
  CreateListingRequest,
  CreateListingResponse,
  FeesResponse,
  HealthResponse,
  Listing,
  ListingsResponse,
  MarketConfig,
  PrepareListingRequest,
  PrepareListingResponse,
} from './types.js';

export { ApiError };
export type { FetchLike };

export interface MarketClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

export interface MarketClient {
  health(): Promise<HealthResponse>;
  config(): Promise<MarketConfig>;
  fees(): Promise<FeesResponse>;
  listings(): Promise<ListingsResponse>;
  listing(inscriptionId: string): Promise<Listing>;
  challenge(req: ChallengeRequest): Promise<ChallengeResponse>;
  prepareListing(req: PrepareListingRequest): Promise<PrepareListingResponse>;
  createListing(req: CreateListingRequest): Promise<CreateListingResponse>;
  cancelListing(inscriptionId: string, req: CancelListingRequest): Promise<Listing>;
  /** 503 `buys_paused` while BUYS_ENABLED=false. */
  buyPrepare(req: BuyPrepareRequest): Promise<BuyPrepareResponse>;
  buySubmit(req: BuySubmitRequest): Promise<BuySubmitResponse>;
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as ApiErrorBody).error?.code === 'string';
}

export function createMarketClient(opts: MarketClientOptions): MarketClient {
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (json !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    } catch (e) {
      throw new ApiError(0, 'network_error', e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      if (isErrorBody(parsed)) throw new ApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.details);
      throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
    }
    if (parsed === undefined) throw new ApiError(res.status, 'invalid_response', 'expected a JSON body');
    return parsed as T;
  }

  const id = (s: string) => encodeURIComponent(s);
  return {
    health: () => call('GET', '/v1/health'),
    config: () => call('GET', '/v1/config'),
    fees: () => call('GET', '/v1/fees'),
    listings: () => call('GET', '/v1/listings'),
    listing: (inscriptionId) => call('GET', `/v1/listings/${id(inscriptionId)}`),
    challenge: (req) => call('POST', '/v1/auth/challenge', req),
    prepareListing: (req) => call('POST', '/v1/listings/prepare', req),
    createListing: (req) => call('POST', '/v1/listings', req),
    cancelListing: (inscriptionId, req) => call('POST', `/v1/listings/${id(inscriptionId)}/cancel`, req),
    buyPrepare: (req) => call('POST', '/v1/buy/prepare', req),
    buySubmit: (req) => call('POST', '/v1/buy/submit', req),
  };
}
