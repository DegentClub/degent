/**
 * Typed fetch client for the degent.club mint HTTP API (contracts/openapi/degent-mint.yaml).
 * Works in the browser and in Node 22 (global fetch); inject `fetch` for tests.
 */
import type {
  ApiErrorBody,
  CreateOrderRequest,
  FeesResponse,
  HealthResponse,
  Order,
  QueueResponse,
  RescueResponse,
  ServiceConfig,
  SubmitRevealRequest,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MintClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /** Extra headers on every request (e.g. tracing). Never put secrets here in the browser. */
  headers?: Record<string, string>;
}

/** Every non-2xx response (and network failure) surfaces as an ApiError. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface MintClient {
  health(): Promise<HealthResponse>;
  config(): Promise<ServiceConfig>;
  fees(): Promise<FeesResponse>;
  queue(): Promise<QueueResponse>;
  createOrder(req: CreateOrderRequest): Promise<Order>;
  uploadContent(orderId: string, bytes: Uint8Array): Promise<Order>;
  submitReveal(orderId: string, req: SubmitRevealRequest): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  getRescue(orderId: string): Promise<RescueResponse>;
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as ApiErrorBody).error === 'object' &&
    typeof (v as ApiErrorBody).error?.code === 'string'
  );
}

export function createMintClient(opts: MintClientOptions): MintClient {
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: { json: unknown } | { bytes: Uint8Array }): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    let payload: BodyInit | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body && 'bytes' in body) {
      headers['content-type'] = 'application/octet-stream';
      payload = body.bytes as unknown as BodyInit;
    }
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, body: payload });
    } catch (e) {
      throw new ApiError(0, 'network_error', e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      if (isErrorBody(parsed)) throw new ApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.details);
      throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
    }
    if (parsed === undefined) throw new ApiError(res.status, 'invalid_response', 'expected a JSON body');
    return parsed as T;
  }

  const id = (orderId: string) => encodeURIComponent(orderId);
  return {
    health: () => call('GET', '/v1/health'),
    config: () => call('GET', '/v1/config'),
    fees: () => call('GET', '/v1/fees'),
    queue: () => call('GET', '/v1/queue'),
    createOrder: (req) => call('POST', '/v1/orders', { json: req }),
    uploadContent: (orderId, bytes) => call('PUT', `/v1/orders/${id(orderId)}/content`, { bytes }),
    submitReveal: (orderId, req) => call('POST', `/v1/orders/${id(orderId)}/reveal`, { json: req }),
    getOrder: (orderId) => call('GET', `/v1/orders/${id(orderId)}`),
    getRescue: (orderId) => call('GET', `/v1/orders/${id(orderId)}/rescue`),
  };
}
