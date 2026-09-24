/**
 * ord JSON API (`Accept: application/json`), e.g. https://ordinals.com:
 *   GET /inscription/{id} → { id, number, address, content_type, content_length, timestamp (unix s), height, fee, … }
 *   GET /address/{addr}   → { inscriptions: [id…], outputs, sat_balance, … }
 * Responses are cached per id (the promise is cached, so concurrent callers share one request;
 * failures are evicted so a retry refetches).
 */
import type { InscriptionDetails, OrdService } from '../types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseInscription(id: string, body: unknown): InscriptionDetails {
  if (typeof body !== 'object' || body === null) throw new Error('ord: not an object');
  const b = body as Json;
  const ts = b.timestamp;
  let timestamp: string | null = null;
  if (typeof ts === 'number' && Number.isFinite(ts)) timestamp = new Date(ts * 1000).toISOString();
  else if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) timestamp = new Date(ts).toISOString();
  return {
    id: s(b.id) ?? id,
    number: n(b.number),
    address: s(b.address),
    contentType: s(b.content_type) ?? s(b.effective_content_type),
    contentLength: n(b.content_length),
    timestamp,
    height: n(b.height),
    fee: n(b.fee),
  };
}

export function createOrdService(opts: { baseUrl: string; fetch?: FetchLike }): OrdService {
  const base = opts.baseUrl;
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  const cache = new Map<string, Promise<InscriptionDetails>>();
  const json = async (path: string) => {
    const res = await fetchFn(`${base}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`ord ${res.status} for ${path}`);
    return res.json() as Promise<unknown>;
  };
  const get = (id: string) => {
    let p = cache.get(id);
    if (!p) {
      p = json(`/inscription/${encodeURIComponent(id)}`).then((b) => parseInscription(id, b));
      cache.set(id, p);
      p.catch(() => cache.delete(id));
    }
    return p;
  };
  return {
    getInscription: get,
    prefetch(id) {
      get(id).catch(() => undefined);
    },
    async getAddressInscriptions(address) {
      const b = (await json(`/address/${encodeURIComponent(address)}`)) as Json;
      return Array.isArray(b.inscriptions) ? b.inscriptions.filter((x): x is string => typeof x === 'string') : [];
    },
    contentUrl: (id) => `${base}/content/${id}`,
    inscriptionUrl: (id) => `${base}/inscription/${id}`,
  };
}
