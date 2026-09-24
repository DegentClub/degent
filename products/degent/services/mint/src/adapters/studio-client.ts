/**
 * StudioClient adapters. `HttpStudioClient` talks to `@bsh/degent-studio` with an API key of scope
 * `studio:internal` (reads any artwork, records royalties). `MemoryStudioClient` is the in-process fake for
 * tests and the regtest dev runtime.
 */
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { StudioClientError, type RoyaltyRecordRequest, type StudioArtwork, type StudioClient } from '../ports/studio-client.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

interface StudioArtworkWire {
  id: string;
  artist: string;
  title?: string;
  contentType: string;
  contentLength: number;
  contentSha256: string | null;
  status: StudioArtwork['status'];
}

const retryableStatus = (status: number) => status >= 500 || status === 429 || status === 408;

export class HttpStudioClient implements StudioClient {
  readonly name = 'studio-http';
  private readonly http: ReturnType<typeof httpClient>;
  private readonly base: string;

  constructor(private readonly opts: { studioUrl: string; apiKey: string | null } & HttpOptions) {
    this.http = httpClient(opts);
    this.base = trimSlash(opts.studioUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}), ...extra };
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.http(`${this.base}${path}`, init);
    } catch (e) {
      throw new StudioClientError(`studio ${path}: ${e instanceof Error ? e.message : String(e)}`, null, true);
    }
  }

  async getArtwork(id: string): Promise<StudioArtwork | null> {
    const res = await this.call(`/v1/artworks/${encodeURIComponent(id)}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new StudioClientError(`studio artwork: HTTP ${res.status}`, res.status, retryableStatus(res.status));
    const a = (await res.json()) as StudioArtworkWire;
    // The payout address is the artist's, not the artwork's, and is not on the public profile: the studio
    // serves it to the mint on an internal route (scope studio:internal, contracts/openapi/degent-studio.yaml).
    let payoutAddress: string | null = null;
    const artist = await this.call(`/v1/internal/artists/${encodeURIComponent(a.artist)}/payout`, { headers: this.headers() });
    if (artist.ok) {
      const p = (await artist.json()) as { payoutAddress?: unknown };
      if (typeof p.payoutAddress === 'string' && p.payoutAddress.length > 0) payoutAddress = p.payoutAddress;
    } else if (artist.status !== 404) throw new StudioClientError(`studio artist: HTTP ${artist.status}`, artist.status, retryableStatus(artist.status));
    return {
      id: a.id,
      artist: a.artist,
      payoutAddress,
      title: a.title ?? '',
      contentType: a.contentType,
      contentLength: a.contentLength,
      contentSha256: a.contentSha256 ?? null,
      status: a.status,
    };
  }

  async getContent(id: string): Promise<Uint8Array | null> {
    const res = await this.call(`/v1/artworks/${encodeURIComponent(id)}/content`, { headers: this.headers({ accept: '*/*' }) });
    if (res.status === 404) return null;
    if (!res.ok) throw new StudioClientError(`studio content: HTTP ${res.status}`, res.status, retryableStatus(res.status));
    return new Uint8Array(await res.arrayBuffer());
  }

  async postRoyalty(record: RoyaltyRecordRequest): Promise<{ created: boolean }> {
    const res = await this.call('/v1/internal/royalties', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(record),
    });
    if (res.status === 201) return { created: true };
    if (res.status === 200) return { created: false };
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      detail = body.error ? ` ${body.error.code ?? ''} ${body.error.message ?? ''}`.trimEnd() : '';
    } catch {
      /* no JSON body */
    }
    throw new StudioClientError(`studio royalties: HTTP ${res.status}${detail}`, res.status, retryableStatus(res.status));
  }
}

export interface MemoryArtwork extends StudioArtwork {
  bytes: Uint8Array | null;
}

/** In-memory studio: seed artworks with `addArtwork`; inspect `royalties`; `down` / `failPosts` simulate outages. */
export class MemoryStudioClient implements StudioClient {
  readonly name = 'studio-memory';
  readonly artworks = new Map<string, MemoryArtwork>();
  readonly royalties: RoyaltyRecordRequest[] = [];
  /** Every call throws (unreachable studio). */
  down = false;
  /** The next N royalty posts fail with a retryable error. */
  failPosts = 0;
  /** The next N royalty posts fail with a NON-retryable error (e.g. 409 conflicting facts). */
  rejectPosts = 0;
  postCalls = 0;

  private guard() {
    if (this.down) throw new StudioClientError('studio unreachable', null, true);
  }

  addArtwork(a: { id: string; artist: string; payoutAddress: string | null; bytes: Uint8Array; contentType: string; status?: StudioArtwork['status']; title?: string }): MemoryArtwork {
    const art: MemoryArtwork = {
      id: a.id,
      artist: a.artist,
      payoutAddress: a.payoutAddress,
      title: a.title ?? `Artwork ${a.id}`,
      contentType: a.contentType,
      contentLength: a.bytes.length,
      contentSha256: sha256Hex(a.bytes),
      status: a.status ?? 'approved',
      bytes: a.bytes,
    };
    this.artworks.set(a.id, art);
    return art;
  }

  async getArtwork(id: string): Promise<StudioArtwork | null> {
    this.guard();
    const a = this.artworks.get(id);
    if (!a) return null;
    const { bytes: _bytes, ...rest } = a;
    return { ...rest };
  }

  async getContent(id: string): Promise<Uint8Array | null> {
    this.guard();
    const a = this.artworks.get(id);
    return a?.bytes && a.status === 'approved' ? Uint8Array.from(a.bytes) : null;
  }

  async postRoyalty(record: RoyaltyRecordRequest): Promise<{ created: boolean }> {
    this.guard();
    this.postCalls++;
    if (this.rejectPosts > 0) {
      this.rejectPosts--;
      throw new StudioClientError('studio royalties: HTTP 409 conflict', 409, false);
    }
    if (this.failPosts > 0) {
      this.failPosts--;
      throw new StudioClientError('studio royalties: HTTP 503', 503, true);
    }
    if (!this.artworks.has(record.artworkId)) throw new StudioClientError('studio royalties: HTTP 404 artwork_not_found', 404, false);
    const existing = this.royalties.find((r) => r.orderId === record.orderId);
    if (existing) {
      const same = existing.artworkId === record.artworkId && existing.royaltySats === record.royaltySats && existing.fundingTxid === record.fundingTxid && existing.vout === record.vout;
      if (!same) throw new StudioClientError('studio royalties: HTTP 409 conflict', 409, false);
      return { created: false };
    }
    this.royalties.push({ ...record });
    return { created: true };
  }
}
