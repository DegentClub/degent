/**
 * Read-only view of an ord server (https://docs.ordinals.com/guides/api.html). Only what
 * certification needs. Adapters: `adapters/http-ord.ts` (real ord), `adapters/fake-ord.ts` (tests/dev).
 */
export interface OrdInscription {
  id: string;
  number: number;
  /** Block height the inscription was revealed at. */
  height: number;
  /** null when the inscription has no body. */
  contentLength: number | null;
  contentType: string | null;
  /** Parent inscription ids as ord records them (empty when none). */
  parents: string[];
}

export interface OrdChildrenPage {
  ids: string[];
  more: boolean;
  page: number;
}

export interface OrdPort {
  /** Height of ord's latest indexed block. */
  blockHeight(): Promise<number>;
  /** null when ord does not know the id (404). */
  inscription(id: string): Promise<OrdInscription | null>;
  /** Children of `parentId`, 0-based pages in ord's order. */
  children(parentId: string, page: number): Promise<OrdChildrenPage>;
  /** Raw content bytes; null when unknown (404). */
  content(id: string): Promise<Uint8Array | null>;
  /**
   * Virtual size (ceil(weight / 4)) of a transaction, or null when unknown. Optional: without it
   * `stats.totalRevealVbytes` is null.
   */
  txVsize?(txid: string): Promise<number | null>;
}

/** ord answered with something that is not the documented shape, or failed. Maps to HTTP 502. */
export class OrdError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OrdError';
  }
}
