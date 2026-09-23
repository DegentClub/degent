/**
 * Resolves a collection's membership from its sources, computes the official stats and issues a
 * signed attestation. All I/O goes through ports; the maths is in `domain/`.
 */
import { signAttestation } from '../domain/attestation.js';
import { sha256Hex } from '../domain/hash.js';
import { ManifestError, manifestSha256, parseManifest, type Manifest } from '../domain/manifest.js';
import type { CollectionRef, Exclusion, Item, ManifestSource, Method, ParentSource, Snapshot, Source, SourceType } from '../domain/model.js';
import { computeStats, revealTxid, sortItems } from '../domain/stats.js';
import type { Clock } from '../ports/clock.js';
import { OrdError, type OrdInscription, type OrdPort } from '../ports/ord.js';
import type { AttestationSigner } from '../ports/signer.js';
import type { SnapshotStore } from '../ports/store.js';

export interface CollectionConfig {
  slug: string;
  name: string;
  /** Collection parent; children linking back to it are members. Also what makes a manifest valid. */
  parentInscriptionId?: string | null;
  manifest?: {
    /** Where the manifest is inscribed (authoritative when set). */
    inscriptionId?: string;
    /** Off-chain copy, already parsed. Its `manifestInscriptionId`, if any, is used as `inscriptionId`. */
    document?: Manifest;
  };
  /** Count the items of a manifest that is not (yet) inscribed as a child of the parent. Preview only. */
  allowUnverifiedManifest?: boolean;
  /** Fetch reveal transaction sizes (one ord /tx call per distinct reveal). Default true. */
  revealVbytes?: boolean;
}

export class ServiceError extends Error {
  constructor(
    readonly code: 'collection_not_found' | 'refresh_in_progress' | 'manifest_invalid' | 'manifest_not_found' | 'parent_not_found' | 'upstream_error',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface CertifyServiceOptions {
  ord: OrdPort;
  signer: AttestationSigner;
  store: SnapshotStore;
  clock: Clock;
  collections: CollectionConfig[];
  /** Parallel ord requests during a refresh. Default 8. */
  concurrency?: number;
  /** Safety cap on children pages per parent. Default 10,000 (1M children at 100/page). */
  maxChildPages?: number;
}

interface Candidate {
  inscription: OrdInscription;
  sources: Set<SourceType>;
}

async function mapLimit<T, R>(xs: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

export class CertifyService {
  private readonly byslug: Map<string, CollectionConfig>;
  private readonly running = new Set<string>();
  private readonly concurrency: number;
  private readonly maxChildPages: number;

  constructor(private readonly o: CertifyServiceOptions) {
    this.byslug = new Map(o.collections.map((c) => [c.slug, c]));
    this.concurrency = o.concurrency ?? 8;
    this.maxChildPages = o.maxChildPages ?? 10_000;
  }

  get signer(): AttestationSigner {
    return this.o.signer;
  }

  collection(slug: string): CollectionConfig | undefined {
    return this.byslug.get(slug);
  }

  async latest(slug: string): Promise<Snapshot | null> {
    if (!this.byslug.has(slug)) throw new ServiceError('collection_not_found', `unknown collection ${slug}`);
    return this.o.store.latest(slug);
  }

  async refresh(slug: string): Promise<Snapshot> {
    const cfg = this.byslug.get(slug);
    if (!cfg) throw new ServiceError('collection_not_found', `unknown collection ${slug}`);
    if (this.running.has(slug)) throw new ServiceError('refresh_in_progress', `a refresh of ${slug} is already running`);
    this.running.add(slug);
    try {
      return await this.run(cfg);
    } catch (e) {
      if (e instanceof OrdError) throw new ServiceError('upstream_error', `ord: ${e.message}`);
      throw e;
    } finally {
      this.running.delete(slug);
    }
  }

  private async run(cfg: CollectionConfig): Promise<Snapshot> {
    const { ord } = this.o;
    const asOf = await ord.blockHeight();
    const parentId = cfg.parentInscriptionId ?? null;
    const candidates = new Map<string, Candidate>();
    const exclusions: Exclusion[] = [];
    const sources: Source[] = [];

    const accept = (i: OrdInscription, source: SourceType) => {
      const c = candidates.get(i.id) ?? { inscription: i, sources: new Set<SourceType>() };
      c.sources.add(source);
      candidates.set(i.id, c);
    };

    if (parentId) {
      const parent = await ord.inscription(parentId);
      if (!parent) throw new ServiceError('parent_not_found', `parent inscription ${parentId} not found on ord`);
      sources.push(await this.fromParent(parentId, asOf, accept, exclusions));
    }
    if (cfg.manifest) sources.push(await this.fromManifest(cfg, parentId, asOf, accept, exclusions));

    const items: Item[] = sortItems(
      [...candidates.values()].map(({ inscription: i, sources: s }) => ({
        inscriptionId: i.id,
        number: i.number,
        contentLength: i.contentLength ?? 0,
        contentType: i.contentType,
        height: i.height,
        sources: (['parent-children', 'manifest'] as const).filter((t) => s.has(t)),
      })),
    );

    // An id accepted by any source is a member; only report exclusions for non-members.
    const finalExclusions = exclusions
      .filter((e) => !candidates.has(e.inscriptionId))
      .sort((a, b) => (a.inscriptionId < b.inscriptionId ? -1 : a.inscriptionId > b.inscriptionId ? 1 : a.source < b.source ? -1 : 1));
    const excludedCount = new Set(finalExclusions.map((e) => e.inscriptionId)).size;

    const vsizes = cfg.revealVbytes === false ? null : await this.revealVsizes(items);
    const stats = computeStats(items, excludedCount, vsizes);

    const types = new Set(sources.map((s) => s.type));
    const method: Method = types.has('parent-children') && types.has('manifest') ? 'parent-children+manifest' : types.has('manifest') ? 'manifest' : 'parent-children';
    const collection: CollectionRef = { slug: cfg.slug, name: cfg.name, parentInscriptionId: parentId };

    const { attestation, digest } = await signAttestation(
      { collection, method, sources, stats, asOfBlockHeight: asOf, issuedAt: this.o.clock.now().toISOString() },
      this.o.signer,
    );
    const snapshot: Snapshot = { attestation, digest, items, exclusions: finalExclusions };
    await this.o.store.put(cfg.slug, snapshot);
    return snapshot;
  }

  private async fromParent(
    parentId: string,
    asOf: number,
    accept: (i: OrdInscription, s: SourceType) => void,
    exclusions: Exclusion[],
  ): Promise<ParentSource> {
    const listed: string[] = [];
    const seen = new Set<string>();
    let pages = 0;
    for (let page = 0; ; page++) {
      if (page >= this.maxChildPages) throw new ServiceError('upstream_error', `children of ${parentId} exceed ${this.maxChildPages} pages`);
      const p = await this.o.ord.children(parentId, page);
      pages++;
      for (const id of p.ids)
        if (!seen.has(id)) {
          seen.add(id);
          listed.push(id);
        }
      if (!p.more) break;
      if (p.ids.length === 0) throw new ServiceError('upstream_error', `ord reported more children of ${parentId} after an empty page ${page}`);
    }
    let accepted = 0;
    let excluded = 0;
    const ex = (inscriptionId: string, reason: Exclusion['reason'], detail?: string) => {
      excluded++;
      exclusions.push(detail ? { inscriptionId, source: 'parent-children', reason, detail } : { inscriptionId, source: 'parent-children', reason });
    };
    const records = await mapLimit(listed, this.concurrency, (id) => this.o.ord.inscription(id));
    listed.forEach((id, k) => {
      const r = records[k];
      if (!r) return ex(id, 'not_found');
      if (!r.parents.includes(parentId)) return ex(id, 'parent_link_missing', 'listed as a child by ord, but its inscription record does not name the parent');
      if (r.height > asOf) return ex(id, 'after_as_of_height', `height ${r.height} > ${asOf}`);
      accepted++;
      accept(r, 'parent-children');
    });
    return { type: 'parent-children', parentInscriptionId: parentId, pages, listed: listed.length, accepted, excluded };
  }

  private async loadManifest(cfg: CollectionConfig, parentId: string | null): Promise<{ manifest: Manifest; inscriptionId: string | null; verified: boolean }> {
    const m = cfg.manifest!;
    const inscriptionId = m.inscriptionId ?? m.document?.manifestInscriptionId ?? null;
    if (!inscriptionId) {
      if (!m.document) throw new ServiceError('manifest_invalid', `collection ${cfg.slug}: manifest has neither inscriptionId nor document`);
      return { manifest: m.document, inscriptionId: null, verified: false };
    }
    const rec = await this.o.ord.inscription(inscriptionId);
    const bytes = rec ? await this.o.ord.content(inscriptionId) : null;
    if (!rec || !bytes) throw new ServiceError('manifest_not_found', `manifest inscription ${inscriptionId} not found on ord`);
    let manifest: Manifest;
    try {
      manifest = parseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (e) {
      throw new ServiceError('manifest_invalid', `manifest inscription ${inscriptionId} is not a valid manifest: ${e instanceof Error ? e.message : String(e)}`, e instanceof ManifestError ? e.issues : undefined);
    }
    if (m.document && manifestSha256(m.document) !== manifestSha256(manifest))
      throw new ServiceError('manifest_invalid', `the configured manifest file differs from the one inscribed at ${inscriptionId}`);
    const verified = parentId !== null && rec.parents.includes(parentId);
    return { manifest, inscriptionId, verified };
  }

  private async fromManifest(
    cfg: CollectionConfig,
    parentId: string | null,
    asOf: number,
    accept: (i: OrdInscription, s: SourceType) => void,
    exclusions: Exclusion[],
  ): Promise<ManifestSource> {
    const { manifest, inscriptionId, verified } = await this.loadManifest(cfg, parentId);
    if (manifest.collection !== cfg.slug)
      throw new ServiceError('manifest_invalid', `manifest is for collection "${manifest.collection}", not "${cfg.slug}"`);
    const base: ManifestSource = {
      type: 'manifest',
      manifestInscriptionId: inscriptionId,
      manifestSha256: manifestSha256(manifest),
      verified,
      listed: manifest.items.length,
      accepted: 0,
      excluded: 0,
    };
    // An unverified manifest is reported but its items are not evaluated (not members, not exclusions).
    if (!verified && !cfg.allowUnverifiedManifest) return base;

    const ex = (inscriptionId: string, reason: Exclusion['reason'], detail?: string) => {
      base.excluded++;
      exclusions.push(detail ? { inscriptionId, source: 'manifest', reason, detail } : { inscriptionId, source: 'manifest', reason });
    };
    const checked = await mapLimit(manifest.items, this.concurrency, async (it) => {
      const r = await this.o.ord.inscription(it.inscriptionId);
      if (!r) return { it, r, hash: undefined };
      if (!it.sha256) return { it, r, hash: undefined };
      const bytes = await this.o.ord.content(it.inscriptionId);
      return { it, r, hash: bytes ? sha256Hex(bytes) : null };
    });
    for (const { it, r, hash } of checked) {
      if (!r) {
        ex(it.inscriptionId, 'not_found');
        continue;
      }
      if (r.height > asOf) {
        ex(it.inscriptionId, 'after_as_of_height', `height ${r.height} > ${asOf}`);
        continue;
      }
      if (it.contentLength !== undefined && it.contentLength !== (r.contentLength ?? 0)) {
        ex(it.inscriptionId, 'content_length_mismatch', `manifest ${it.contentLength}, ord ${r.contentLength ?? 0}`);
        continue;
      }
      if (it.sha256 !== undefined) {
        if (hash === null) {
          ex(it.inscriptionId, 'content_unavailable');
          continue;
        }
        if (hash !== it.sha256) {
          ex(it.inscriptionId, 'sha256_mismatch', `manifest ${it.sha256}, content ${hash}`);
          continue;
        }
      }
      base.accepted++;
      accept(r, 'manifest');
    }
    return base;
  }

  /** vsize per distinct reveal txid, or null when the port cannot size one of them. */
  private async revealVsizes(items: Item[]): Promise<Map<string, number> | null> {
    const port = this.o.ord;
    if (!port.txVsize || items.length === 0) return items.length === 0 ? new Map() : null;
    const txids = [...new Set(items.map((i) => revealTxid(i.inscriptionId)))];
    try {
      const sizes = await mapLimit(txids, this.concurrency, (t) => port.txVsize!(t));
      if (sizes.some((s) => s === null)) return null;
      return new Map(txids.map((t, k) => [t, sizes[k]!]));
    } catch {
      return null;
    }
  }
}

