import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** What `apiKeys()` puts on the context for an authenticated caller. Never contains the secret. */
export interface ApiKeyPrincipal {
  id: string;
  env: 'live' | 'test';
  scopes: readonly string[];
  ownerId?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    clientIp: string;
    apiKey: ApiKeyPrincipal;
  }
}

/** The one error body every public service returns. */
export interface ErrorBody {
  error: { code: string; message: string; requestId: string | null };
}

export function errorBody(c: Context, code: string, message: string): ErrorBody {
  return { error: { code, message, requestId: c.get('requestId') ?? null } };
}

/** Build a uniform JSON error response. */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.json(errorBody(c, code, message), status, headers);
}

/** Set a header on the current response, re-wrapping it if its headers are immutable (e.g. a fetch() result). */
export function setResponseHeader(c: Context, name: string, value: string): void {
  try {
    c.res.headers.set(name, value);
  } catch {
    const res = new Response(c.res.body, c.res);
    res.headers.set(name, value);
    c.res = res;
  }
}

export function appendVary(c: Context, value: string): void {
  const cur = c.res.headers.get('Vary');
  if (!cur) return setResponseHeader(c, 'Vary', value);
  const parts = cur.split(',').map((s) => s.trim().toLowerCase());
  if (parts.includes('*') || parts.includes(value.toLowerCase())) return;
  setResponseHeader(c, 'Vary', `${cur}, ${value}`);
}
