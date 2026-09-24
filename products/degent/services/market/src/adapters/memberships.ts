/**
 * CollectionMembership adapters (see ports/membership.ts):
 *
 * - MemoryMembership: an explicit map (tests, regtest dev).
 * - RosterOrdMembership: the roster JSON (Gallery ids → Degent numbers) plus ord's
 *   `/r/parents/<id>` for children of the club parent (the parent link is only applied after member
 *   approval, ADR-0007, so a parent-linked child IS a Degent). Positive answers are cached.
 * - MintRegisterMembership: the mint's public Register (`GET /v1/register/verify/{id}`) through the
 *   typed client in `@bsh/degent-mint-sdk`; the Register already covers Gallery + approved children.
 *   No mint service code is imported: the SDK and the OpenAPI contract are the boundary.
 */
import { ApiError, createMintClient, type MintClient } from '@bsh/degent-mint-sdk';
import type { DegentRef } from '@bsh/degent-market-sdk';
import { UpstreamError } from '../ports/chain.js';
import type { CollectionMembership } from '../ports/membership.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

export class MemoryMembership implements CollectionMembership {
  private readonly refs = new Map<string, DegentRef>();

  constructor(entries: Array<[string, DegentRef]> = []) {
    for (const [id, ref] of entries) this.refs.set(id, ref);
  }

  set(inscriptionId: string, ref: DegentRef): void {
    this.refs.set(inscriptionId, ref);
  }

  async lookup(inscriptionId: string): Promise<DegentRef | null> {
    return this.refs.get(inscriptionId) ?? null;
  }
}

export interface RosterEntry {
  n: number;
  inscriptionId: string;
}

export class RosterOrdMembership implements CollectionMembership {
  private readonly gallery = new Map<string, number>();
  private readonly children = new Map<string, boolean>();
  private readonly http: ReturnType<typeof httpClient>;
  private readonly ord: string;

  constructor(roster: readonly RosterEntry[], private readonly opts: { ordUrl: string; parentInscriptionId: string | null } & HttpOptions) {
    for (const m of roster) this.gallery.set(m.inscriptionId, m.n);
    this.http = httpClient(opts);
    this.ord = trimSlash(opts.ordUrl);
  }

  get size(): number {
    return this.gallery.size;
  }

  async lookup(inscriptionId: string): Promise<DegentRef | null> {
    const n = this.gallery.get(inscriptionId);
    if (n !== undefined) return { via: 'gallery', n };
    const parent = this.opts.parentInscriptionId;
    if (!parent) return null;
    if (this.children.get(inscriptionId)) return { via: 'child', n: null };
    let res: Response;
    try {
      res = await this.http(`${this.ord}/r/parents/${encodeURIComponent(inscriptionId)}`, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new UpstreamError(`ord parents: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(`ord parents: HTTP ${res.status}`);
    const j = (await res.json()) as { ids?: unknown[] };
    const isChild = Array.isArray(j.ids) && j.ids.includes(parent);
    if (isChild) this.children.set(inscriptionId, true); // a parent link is permanent
    return isChild ? { via: 'child', n: null } : null;
  }
}

export class MintRegisterMembership implements CollectionMembership {
  private readonly client: MintClient;

  constructor(opts: { mintApiUrl: string; fetch?: HttpOptions['fetch'] }) {
    this.client = createMintClient({ baseUrl: opts.mintApiUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async lookup(inscriptionId: string): Promise<DegentRef | null> {
    try {
      const r = await this.client.registerVerify(inscriptionId);
      return r.member && r.via ? { via: r.via, n: r.n } : null;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) return null;
      throw new UpstreamError(`mint register: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
