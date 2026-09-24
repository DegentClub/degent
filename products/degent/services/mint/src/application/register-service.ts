/**
 * The Register API (ADR-0007 §4, docs/REGISTER.md): the Gallery roster plus every approved child
 * the mint delivered, with owners from the HolderRegistry. Read-only; nothing here moves funds.
 */
import type {
  ExplorerQuery,
  ExplorerResponse,
  HolderResponse,
  RegisterMember,
  RegisterSummary,
  StatsResponse,
  VerifyMembershipResponse,
} from '@bsh/degent-mint-sdk';
import { CHARTER_SIZE } from '@bsh/degent-mint-sdk';
import { addressKind } from '../domain/address.js';
import { invalid, notFound } from '../domain/errors.js';
import type { OrderRecord } from '../domain/order.js';
import { matchesQuery, median, sizeHistogram, sortMembers, topHolders, weekBuckets, type RosterMember, type SortKey } from '../domain/roster.js';
import type { Clock } from '../ports/clock.js';
import type { HolderRegistry } from '../ports/holder-registry.js';
import type { OrderStore } from '../ports/order-store.js';
import type { MintSettings } from './settings.js';

export interface RegisterServiceDeps {
  settings: MintSettings;
  roster: readonly RosterMember[];
  store: OrderStore;
  holders: HolderRegistry;
  clock: Clock;
  /** Owners are fetched lazily per page; this caps how many members get an owner lookup per stats call (default all). */
  ownerLookupLimit?: number;
  /** Stats (which look up every owner) are cached this long; 0 disables the cache (tests). Default 600 s. */
  statsCacheSeconds?: number;
  /** Parallel owner lookups against the indexer (default 8). */
  ownerConcurrency?: number;
}

const ID_RE = /^[0-9a-f]{64}i\d+$/;
const MAX_LIMIT = 200;

export class RegisterService {
  private statsCache: { at: number; value: StatsResponse } | null = null;

  constructor(private readonly d: RegisterServiceDeps) {}

  private contentUrl(id: string): string {
    return `${this.d.settings.ordPublicUrl}/content/${id}`;
  }

  private galleryMember(m: RosterMember): RegisterMember {
    return {
      n: m.n,
      id: m.inscriptionId,
      number: m.inscriptionNumber,
      via: 'gallery',
      bytes: m.bytes,
      height: m.height,
      sat: m.sat,
      owner: null,
      contentUrl: this.contentUrl(m.inscriptionId),
    };
  }

  private childMember(r: OrderRecord): RegisterMember | null {
    if (r.degentNumber === null || !r.inscriptionId || r.rescued) return null;
    const delivered = r.timeline.find((e) => e.status === 'confirmed');
    return {
      n: r.degentNumber,
      id: r.inscriptionId,
      number: null,
      via: 'child',
      bytes: r.contentLength,
      height: heightFromDetail(delivered?.detail),
      sat: null,
      owner: r.recipientAddress,
      contentUrl: this.contentUrl(r.inscriptionId),
    };
  }

  /** Delivered, parent-linked children (approved by the members) become Register members. */
  private async children(): Promise<{ members: RegisterMember[]; records: OrderRecord[] }> {
    const records = (await this.d.store.listByStatus(['delivered'])).filter((r) => r.degentNumber !== null && !r.rescued);
    const members = records.map((r) => this.childMember(r)).filter((m): m is RegisterMember => m !== null);
    return { members, records };
  }

  private async all(): Promise<RegisterMember[]> {
    const gallery = this.d.roster.map((m) => this.galleryMember(m));
    const { members } = await this.children();
    return [...gallery, ...members].sort((a, b) => a.n - b.n);
  }

  private async withOwners(members: RegisterMember[]): Promise<RegisterMember[]> {
    const out = [...members];
    const width = Math.max(1, this.d.ownerConcurrency ?? 8);
    let cursor = 0;
    const worker = async () => {
      while (cursor < out.length) {
        const i = cursor++;
        const m = out[i]!;
        if (m.via === 'gallery') out[i] = { ...m, owner: await this.d.holders.holderOf(m.n) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, out.length) }, worker));
    return out;
  }

  async summary(): Promise<RegisterSummary> {
    const all = await this.all();
    const pending = (await this.d.store.listByStatus(['queued', 'revealing', 'revealed', 'confirmed', 'verified'])).filter((r) => r.degentNumber !== null).length;
    return {
      parent: this.d.settings.collection.parentInscriptionId,
      gallery: this.d.settings.galleryInscriptionId,
      count: all.length,
      bytes: all.reduce((a, m) => a + m.bytes, 0),
      pending,
      updatedAt: this.d.clock.now().toISOString(),
    };
  }

  async member(nRaw: string): Promise<RegisterMember> {
    const n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1 || n > CHARTER_SIZE) throw notFound('Degent');
    const m = (await this.all()).find((x) => x.n === n);
    if (!m) throw notFound('Degent');
    return (await this.withOwners([m]))[0]!;
  }

  async holder(address: string): Promise<HolderResponse> {
    if (addressKind(address, this.d.settings.network) === null) throw invalid(`address is not a valid ${this.d.settings.network} address`);
    const { degents } = await this.d.holders.isHolder(address);
    return { address, holder: degents.length > 0, degents };
  }

  async verify(id: string): Promise<VerifyMembershipResponse> {
    if (!ID_RE.test(id)) throw invalid('inscriptionId must look like <txid>i<index>');
    const m = (await this.all()).find((x) => x.id === id);
    return m ? { id, member: true, via: m.via, n: m.n } : { id, member: false, via: null, n: null };
  }

  async explorer(q: ExplorerQuery & Record<string, unknown>): Promise<ExplorerResponse> {
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = intParam(q.limit, 48, 1, MAX_LIMIT, 'limit');
    const sort = enumParam(q.sort, ['n', 'bytes', 'height'] as const, 'n', 'sort') as SortKey;
    const order = enumParam(q.order, ['asc', 'desc'] as const, 'asc', 'order');
    const text = typeof q.q === 'string' ? q.q : '';
    if (text.length > 100) throw invalid('q must be at most 100 characters');
    const rawTier: unknown = q.tier;
    const tier = rawTier === undefined || rawTier === '' ? null : enumParam(rawTier, ['standard', 'block'] as const, 'standard', 'tier');
    let minBytes = intParam(q.minBytes, 0, 0, Number.MAX_SAFE_INTEGER, 'minBytes');
    let maxBytes = intParam(q.maxBytes, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, 'maxBytes');
    if (maxBytes < minBytes) throw invalid('maxBytes must be at least minBytes');
    if (tier) {
      const rule = this.d.settings.collection.tiers.find((t) => t.tier === tier);
      if (rule) {
        minBytes = Math.max(minBytes, rule.minBytes);
        maxBytes = Math.min(maxBytes, rule.maxBytes);
      }
    }
    const all = (await this.all()).filter((m) => m.bytes >= minBytes && m.bytes <= maxBytes);
    // An owner-prefix query needs owners before filtering; anything else only for the page shown.
    const ownerQuery = text.length > 0 && !/^#?\d+$/.test(text) && !/^[0-9a-f]+$/i.test(text);
    const pool = ownerQuery ? await this.withOwners(all) : all;
    const filtered = pool.filter((m) => matchesQuery(m, text));
    const sorted = sortMembers(filtered, sort, order);
    const page = await this.withOwners(sorted.slice(offset, offset + limit));
    return { items: page, total: filtered.length, offset, limit, sort, order };
  }

  async stats(): Promise<StatsResponse> {
    const ttl = (this.d.statsCacheSeconds ?? 600) * 1000;
    const nowMs = this.d.clock.now().getTime();
    if (this.statsCache && nowMs - this.statsCache.at < ttl) return this.statsCache.value;
    const value = await this.computeStats();
    this.statsCache = { at: nowMs, value };
    return value;
  }

  private async computeStats(): Promise<StatsResponse> {
    const all = await this.all();
    const bytes = all.map((m) => m.bytes);
    const inReview = (await this.d.store.listByStatus(['member_review'])).length;
    const declined = (await this.d.store.listByStatus(['declined'])).length;
    const approvedRecords = (await this.d.store.listByStatus(['queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered', 'rescue_available'])).filter(
      (r) => r.approvedAt !== null,
    );
    const toQuorum = approvedRecords
      .filter((r) => r.reviewStartedAt && r.approvedAt)
      .map((r) => (Date.parse(r.approvedAt!) - Date.parse(r.reviewStartedAt!)) / 1000);
    const limit = this.d.ownerLookupLimit ?? all.length;
    const owners = (await this.withOwners(all.slice(0, limit))).map((m) => m.owner);
    return {
      minted: all.length,
      charter: CHARTER_SIZE,
      totalBytes: bytes.reduce((a, b) => a + b, 0),
      medianBytes: median(bytes),
      mintsPerWeek: weekBuckets([
        ...this.d.roster.map((m) => m.timestamp).filter((t): t is string => t !== null),
        ...approvedRecords.filter((r) => r.status === 'delivered').map((r) => r.timeline.find((e) => e.status === 'confirmed')?.at ?? r.updatedAt),
      ]),
      sizeHistogram: sizeHistogram(bytes),
      approvals: {
        inReview,
        approved: approvedRecords.length,
        declined,
        perWeek: weekBuckets(approvedRecords.map((r) => r.approvedAt!)),
        medianSecondsToQuorum: toQuorum.length ? median(toQuorum) : null,
      },
      topHolders: topHolders(owners),
      updatedAt: this.d.clock.now().toISOString(),
    };
  }
}

function heightFromDetail(detail: string | undefined): number | null {
  const m = /^block (\d+)$/.exec(detail ?? '');
  return m ? Number(m[1]) : null;
}

function intParam(v: unknown, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer in ${min}..${max}`);
  return n;
}

function enumParam<T extends string>(v: unknown, allowed: readonly T[], def: T, name: string): T {
  if (v === undefined || v === '') return def;
  if (!allowed.includes(v as T)) throw invalid(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}
