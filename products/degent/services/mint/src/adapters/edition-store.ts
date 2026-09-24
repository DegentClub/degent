/**
 * EditionStore over an OrderStore's meta area: one JSON document per artwork under `editions:<artworkId>`.
 * Works unchanged on the memory and node:sqlite stores. Read-modify-write per artwork is serialised in
 * process (the mint runs one worker and one API replica per store; node:sqlite calls are synchronous, so a
 * file store never interleaves either).
 */
import type { EditionReservation, EditionStore } from '../ports/edition-store.js';
import type { OrderStore } from '../ports/order-store.js';

interface EditionDoc {
  /** orderId -> reservation. Consumed ones stay forever (they are the editions). */
  reservations: Record<string, EditionReservation>;
}

const KEY = (artworkId: string) => `editions:${artworkId}`;

export class MetaEditionStore implements EditionStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Pick<OrderStore, 'getMeta' | 'setMeta'>) {}

  /** Run `fn` with exclusive access to the artwork's document. */
  private async locked<T>(artworkId: string, fn: (doc: EditionDoc, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const prev = this.locks.get(artworkId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.locks.set(artworkId, prev.then(() => mine));
    await prev;
    try {
      const raw = await this.store.getMeta(KEY(artworkId));
      const doc: EditionDoc = raw ? (JSON.parse(raw) as EditionDoc) : { reservations: {} };
      return await fn(doc, () => this.store.setMeta(KEY(artworkId), JSON.stringify(doc)));
    } finally {
      release();
      if (this.locks.get(artworkId) === prev.then(() => mine)) this.locks.delete(artworkId);
    }
  }

  private static prune(doc: EditionDoc, now: Date): void {
    const t = now.getTime();
    for (const [id, r] of Object.entries(doc.reservations)) if (!r.consumed && Date.parse(r.expiresAt) <= t) delete doc.reservations[id];
  }

  private static held(doc: EditionDoc, exceptOrderId?: string): Set<number> {
    const out = new Set<number>();
    for (const r of Object.values(doc.reservations)) if (r.orderId !== exceptOrderId) out.add(r.edition);
    return out;
  }

  async reserve(artworkId: string, orderId: string, expiresAt: Date, now: Date): Promise<number> {
    return this.locked(artworkId, async (doc, save) => {
      MetaEditionStore.prune(doc, now);
      const mine = doc.reservations[orderId];
      if (mine) {
        if (!mine.consumed) mine.expiresAt = expiresAt.toISOString();
        await save();
        return mine.edition;
      }
      const held = MetaEditionStore.held(doc);
      let edition = 1;
      while (held.has(edition)) edition++;
      doc.reservations[orderId] = { orderId, edition, expiresAt: expiresAt.toISOString(), consumed: false };
      await save();
      return edition;
    });
  }

  async consume(artworkId: string, orderId: string, edition: number, now: Date): Promise<number | null> {
    return this.locked(artworkId, async (doc, save) => {
      const mine = doc.reservations[orderId];
      if (mine?.consumed) return mine.edition;
      // Live, expired-but-on-record, or released: the quoted number is ours unless someone else holds it.
      MetaEditionStore.prune(doc, now);
      if (MetaEditionStore.held(doc, orderId).has(edition)) {
        delete doc.reservations[orderId];
        await save();
        return null;
      }
      doc.reservations[orderId] = { orderId, edition, expiresAt: mine?.expiresAt ?? now.toISOString(), consumed: true };
      await save();
      return edition;
    });
  }

  async release(artworkId: string, orderId: string): Promise<void> {
    await this.locked(artworkId, async (doc, save) => {
      const mine = doc.reservations[orderId];
      if (!mine || mine.consumed) return;
      delete doc.reservations[orderId];
      await save();
    });
  }

  async reservation(artworkId: string, orderId: string): Promise<EditionReservation | null> {
    const raw = await this.store.getMeta(KEY(artworkId));
    if (!raw) return null;
    const doc = JSON.parse(raw) as EditionDoc;
    const r = doc.reservations[orderId];
    return r ? { ...r } : null;
  }

  async consumedCount(artworkId: string): Promise<number> {
    const raw = await this.store.getMeta(KEY(artworkId));
    if (!raw) return 0;
    return Object.values((JSON.parse(raw) as EditionDoc).reservations).filter((r) => r.consumed).length;
  }
}
