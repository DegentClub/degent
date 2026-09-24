/**
 * Operator endpoints (`/v1/admin/*`, contracts/openapi/degent-mint.yaml tag `admin`). Authenticated with
 * @bsh/edge API keys (hash-only records from MINT_ADMIN_API_KEYS_JSON) holding scope `mint:admin`; edge's
 * error bodies are re-shaped into the mint's uniform `{ error: { code, message } }` (401 `unauthorized`,
 * 403 `forbidden`).
 *
 *   POST /v1/admin/parent/ack   close the parent value circuit breaker (RUNBOOK "Re-leasing or
 *                               re-initialising the parent"). The body names the parent the operator
 *                               checked; a mismatch is 409 so a stale acknowledgement cannot resume
 *                               co-signing on a parent nobody looked at.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiKeys, InMemoryApiKeyStore, type ApiKeyEnv, type ApiKeyStore } from '@bsh/edge';
import type { ApiErrorBody } from '@bsh/degent-mint-sdk';
import type { Logger } from './application/logger.js';
import { DomainError } from './domain/errors.js';
import type { Clock } from './ports/clock.js';
import type { ParentUtxoProvider } from './ports/parent-utxo.js';

export const SCOPE_MINT_ADMIN = 'mint:admin';
const OUTPOINT = /^[0-9a-f]{64}:\d{1,10}$/;

export interface AdminOptions {
  keys?: ApiKeyStore;
  /** Only keys of this environment are accepted (live on mainnet). */
  environment?: ApiKeyEnv;
}

function body(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** @bsh/edge `apiKeys` (scope mint:admin) with its error responses mapped onto the mint's error codes. */
function adminAuth(o: AdminOptions): MiddlewareHandler {
  const guard = apiKeys({ store: o.keys ?? new InMemoryApiKeyStore(), scopes: [SCOPE_MINT_ADMIN], ...(o.environment ? { environment: o.environment } : {}) });
  return async (c, next) => {
    const res = await guard(c, next);
    if (!(res instanceof Response)) return;
    const edge = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: { message?: string } } | null;
    const status = res.status === 403 ? 403 : res.status === 429 ? 429 : 401;
    const code = status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'unauthorized';
    const headers: Record<string, string> = {};
    for (const h of ['www-authenticate', 'retry-after']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return c.json(body(code, edge?.error?.message ?? 'admin API key required'), status, headers);
  };
}

export function registerAdminRoutes(
  app: Hono,
  d: { parents?: ParentUtxoProvider; clock: Clock; log: Logger; admin?: AdminOptions; readJson: (c: Parameters<MiddlewareHandler>[0]) => Promise<unknown> },
): void {
  const auth = adminAuth(d.admin ?? {});

  app.post('/v1/admin/parent/ack', auth, bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json(body('payload_too_large', 'request body exceeds 4096 bytes'), 413) }), async (c) => {
    const req = (await d.readJson(c)) as Record<string, unknown> | null;
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new DomainError('validation_failed', 422, 'body must be a JSON object');
    const outpoint = typeof req.outpoint === 'string' ? req.outpoint.toLowerCase() : '';
    const valueSats = req.valueSats;
    const note = req.note;
    if (!OUTPOINT.test(outpoint)) throw new DomainError('validation_failed', 422, 'outpoint must be <txid>:<vout> of the current parent');
    if (typeof valueSats !== 'number' || !Number.isSafeInteger(valueSats) || valueSats < 0)
      throw new DomainError('validation_failed', 422, 'valueSats must be the current parent value in sats');
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new DomainError('validation_failed', 422, 'note must be a string of at most 500 characters');
    if (!d.parents) throw new DomainError('conflict', 409, 'no parent provider configured');
    const by = c.get('apiKey')?.id ?? 'unknown';
    const r = await d.parents.acknowledgeValueChange({ outpoint, valueSats, by, at: d.clock.now(), ...(note ? { note: note as string } : {}) });
    if (!r.ok) {
      const message = r.reason === 'no_parent' ? 'no parent UTXO is known' : 'outpoint/valueSats do not match the current parent; re-check it and acknowledge what is there now';
      throw new DomainError('conflict', 409, message, { current: r.parent });
    }
    if (r.acknowledged) d.log.warn('parent value change acknowledged; co-signing resumes', { by, parent: r.parent, previous: r.acknowledged.alert.previous });
    return c.json({ circuit: 'closed', parent: r.parent, acknowledged: r.acknowledged });
  });
}
