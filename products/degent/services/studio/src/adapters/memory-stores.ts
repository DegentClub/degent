/** In-memory stores (dev, tests). Records are deep-copied in and out. */
import type { ArtistRecord, ArtworkCounts } from '../domain/artist.js';
import type { ArtworkRecord } from '../domain/artwork.js';
import { StaleWriteError } from '../domain/errors.js';
import type { RoyaltyRecord } from '../domain/royalty.js';
import type { ArtistStore } from '../ports/artist-store.js';
import type { ArtworkPage, ArtworkQuery, ArtworkStore } from '../ports/artwork-store.js';
import type { RoyaltyPage, RoyaltyStore } from '../ports/royalty-store.js';

export { InMemoryNonceStore as MemoryNonceStore } from '@bsh/identity';

export class MemoryArtistStore implements ArtistStore {
  private readonly rows = new Map<string, ArtistRecord>();

  async create(r: ArtistRecord): Promise<void> {
    if (this.rows.has(r.address)) throw new Error(`artist ${r.address} already exists`);
    this.rows.set(r.address, structuredClone(r));
  }

  async get(address: string): Promise<ArtistRecord | null> {
    const r = this.rows.get(address);
    return r ? structuredClone(r) : null;
  }

  async save(r: ArtistRecord): Promise<ArtistRecord> {
    const cur = this.rows.get(r.address);
    if (!cur || cur.version !== r.version) throw new StaleWriteError(r.address, r.version);
    const next = structuredClone({ ...r, version: r.version + 1 });
    this.rows.set(r.address, next);
    return structuredClone(next);
  }
}

/** Gallery order: featured first, then newest (createdAt desc), id desc as the tiebreak. */
export function galleryOrder(a: ArtworkRecord, b: ArtworkRecord): number {
  return Number(b.featured) - Number(a.featured) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export class MemoryArtworkStore implements ArtworkStore {
  private readonly rows = new Map<string, ArtworkRecord>();

  async create(r: ArtworkRecord): Promise<void> {
    if (this.rows.has(r.id)) throw new Error(`artwork ${r.id} already exists`);
    this.rows.set(r.id, structuredClone(r));
  }

  async get(id: string): Promise<ArtworkRecord | null> {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async save(r: ArtworkRecord): Promise<ArtworkRecord> {
    const cur = this.rows.get(r.id);
    if (!cur || cur.version !== r.version) throw new StaleWriteError(r.id, r.version);
    const next = structuredClone({ ...r, version: r.version + 1 });
    this.rows.set(r.id, next);
    return structuredClone(next);
  }

  async list(q: ArtworkQuery): Promise<ArtworkPage> {
    const all = [...this.rows.values()]
      .filter((r) => (q.status === undefined || r.status === q.status) && (q.artist === undefined || r.artist === q.artist))
      .sort(galleryOrder);
    const start = (q.page - 1) * q.pageSize;
    return { items: all.slice(start, start + q.pageSize).map((r) => structuredClone(r)), total: all.length };
  }

  async countByArtist(address: string): Promise<ArtworkCounts> {
    let total = 0;
    let approved = 0;
    for (const r of this.rows.values()) {
      if (r.artist !== address) continue;
      total++;
      if (r.status === 'approved') approved++;
    }
    return { total, approved };
  }
}

export class MemoryRoyaltyStore implements RoyaltyStore {
  private readonly rows = new Map<string, RoyaltyRecord>();

  async create(r: RoyaltyRecord): Promise<void> {
    if (this.rows.has(r.orderId)) throw new Error(`royalty for order ${r.orderId} already exists`);
    this.rows.set(r.orderId, structuredClone(r));
  }

  async getByOrder(orderId: string): Promise<RoyaltyRecord | null> {
    const r = this.rows.get(orderId);
    return r ? structuredClone(r) : null;
  }

  async listByArtist(address: string, page: number, pageSize: number): Promise<RoyaltyPage> {
    const all = [...this.rows.values()]
      .filter((r) => r.artist === address)
      .sort((a, b) => b.at.localeCompare(a.at) || b.orderId.localeCompare(a.orderId));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => structuredClone(r)),
      total: all.length,
      totals: { records: all.length, royaltySats: all.reduce((s, r) => s + r.royaltySats, 0) },
    };
  }
}
