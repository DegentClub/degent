/**
 * OrdIndexer over ord's recursive endpoints: GET /r/inscription/:id (satpoint, output, value, address)
 * and GET /r/utxo/:outpoint (inscriptions on an output). 404 → null / [].
 */
import { UpstreamError } from '../ports/chain.js';
import type { InscriptionLocation, OrdIndexer } from '../ports/ord.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

export class OrdRecursiveIndexer implements OrdIndexer {
  private readonly http: ReturnType<typeof httpClient>;
  private readonly base: string;

  constructor(opts: { ordUrl: string } & HttpOptions) {
    this.http = httpClient(opts);
    this.base = trimSlash(opts.ordUrl);
  }

  private async json<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new UpstreamError(`ord ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(`ord ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async getInscription(id: string): Promise<InscriptionLocation | null> {
    const j = await this.json<{ id?: string; number?: number; address?: string | null; satpoint?: string; output?: string; value?: number; content_type?: string }>(
      `/r/inscription/${encodeURIComponent(id)}`,
    );
    if (!j) return null;
    const [txid, vout, offset] = String(j.satpoint ?? '').split(':');
    const outpoint = j.output ?? (txid && vout ? `${txid}:${vout}` : '');
    if (!/^[0-9a-f]{64}:\d+$/.test(outpoint) || typeof j.value !== 'number') return null;
    return {
      id: j.id ?? id,
      number: typeof j.number === 'number' ? j.number : null,
      address: typeof j.address === 'string' && j.address.length > 0 ? j.address : null,
      outpoint,
      offset: Number(offset ?? 0) || 0,
      value: j.value,
      contentType: j.content_type ?? '',
    };
  }

  async getOutpointInscriptions(outpoint: string): Promise<string[]> {
    const j = await this.json<{ inscriptions?: unknown[] }>(`/r/utxo/${encodeURIComponent(outpoint)}`);
    return Array.isArray(j?.inscriptions) ? j.inscriptions.filter((x): x is string => typeof x === 'string') : [];
  }
}
