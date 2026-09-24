/**
 * HTTP client for the Atelier (`contracts/openapi/degent-atelier.yaml`, implemented by
 * `@bsh/degent-atelier`). Talks HTTP only: the web app never imports the service's code.
 *
 * The anonymous session token (`atl_…`) lives in this closure only: never in URLs, storage or logs.
 * Errors become `AtelierError` with the contract's `code`, the HTTP status and `Retry-After`.
 */
import type {
  AtelierConfig,
  AtelierHealth,
  AtelierJob,
  AtelierQuota,
  AtelierService,
  FinalizedContent,
  GenerateRequest,
} from '../types';
import { AtelierError } from '../types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function toError(res: Response): Promise<AtelierError> {
  let code = 'internal_error';
  let message = `Atelier error (HTTP ${res.status})`;
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    /* non-JSON error body */
  }
  const ra = Number(res.headers.get('retry-after'));
  return new AtelierError(code, message, res.status, Number.isFinite(ra) && ra > 0 ? ra : null, details);
}

export function createHttpAtelier(opts: { baseUrl: string; fetch?: FetchLike }): AtelierService {
  const base = opts.baseUrl;
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  let token: string | null = null;
  let quota: AtelierQuota | null = null;

  const call = async (path: string, init: RequestInit = {}, auth = false): Promise<Response> => {
    if (!base) throw new AtelierError('not_configured', 'The Atelier is not configured on this site.');
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (auth) {
      if (!token) await ensure();
      headers.set('authorization', `Bearer ${token}`);
    }
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, { ...init, headers });
    } catch {
      throw new AtelierError('network', 'The Atelier could not be reached. Check your connection and try again.');
    }
    if (res.status === 401 && auth) token = null; // expired session: the next call opens a new one
    if (!res.ok) throw await toError(res);
    return res;
  };
  const json = async <T>(path: string, init?: RequestInit, auth = false): Promise<T> => (await call(path, init, auth)).json() as Promise<T>;

  const ensure = async (): Promise<AtelierQuota> => {
    if (token && quota) return quota;
    const s = await json<{ token: string; quota: AtelierQuota }>('/v1/sessions', { method: 'POST' });
    token = s.token;
    quota = s.quota;
    return quota;
  };

  const abs = (url: string) => (/^https?:/.test(url) ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`);

  return {
    configured: !!base,
    health: () => json<AtelierHealth>('/v1/health'),
    config: () => json<AtelierConfig>('/v1/config'),
    ensureSession: ensure,
    async generate(req: GenerateRequest) {
      const r = await json<{ jobId: string; quota: AtelierQuota }>(
        '/v1/generate',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
        true,
      );
      quota = r.quota;
      return { jobId: r.jobId, quota: r.quota };
    },
    async getJob(jobId) {
      const j = await json<AtelierJob>(`/v1/jobs/${encodeURIComponent(jobId)}`, {}, true);
      return { ...j, candidates: j.candidates.map((c) => ({ ...c, previewUrl: abs(c.previewUrl) })) };
    },
    finalize: (candidateId, req) =>
      json<FinalizedContent>(
        `/v1/candidates/${encodeURIComponent(candidateId)}/finalize`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
        true,
      ),
    async upload(file, o) {
      const q = new URLSearchParams({ tier: o.tier, frame: o.frame ? 'true' : 'false' });
      if (o.placard) q.set('placard', o.placard);
      return json<FinalizedContent>(
        `/v1/upload?${q}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file },
        true,
      );
    },
    async getContent(sha256) {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AtelierError('validation_failed', 'bad content hash');
      const res = await call(`/v1/content/${sha256}`, { headers: { accept: 'image/jpeg' } });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
