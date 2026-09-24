/**
 * Fakes for the site ports: tests and `?demo=1`. No network. Everything is deterministic.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { readImageInfo, sniffContentType, tierForSize, TIER_LABELS, type Tier } from '@bsh/degent-mint-sdk';
import type {
  AtelierCandidate,
  AtelierConfig,
  AtelierJob,
  AtelierQuota,
  AtelierReview,
  AtelierService,
  CollectionItem,
  CollectionList,
  CollectionService,
  CollectionStats,
  FinalizedContent,
  InscriptionDetails,
  NewsletterService,
  OrdService,
  Placard,
  SiteServices,
  StatsService,
} from './types';
import { AtelierError } from './types';
import { bundledStats, loadBundledCollection } from './bundled';
import { gentlemanDataUrl, hashSeed } from '../lib/art';
import { syntheticJpeg } from '../lib/jpeg';
import { validateNewsletter } from './real/newsletter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ stats

export function createFakeStats(stats: CollectionStats | Error | (() => Promise<CollectionStats>)): StatsService {
  return {
    async getStats() {
      if (stats instanceof Error) throw stats;
      if (typeof stats === 'function') return stats();
      return stats;
    },
  };
}

// ------------------------------------------------------------------ collection

export function fakeItems(count: number, offset = 0): CollectionItem[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i + 1;
    const txid = hex.encode(sha256(new TextEncoder().encode(`degent-${n}`)));
    return { id: `${txid}i0`, number: n, name: `Degent #${n}`, size_kb: 200 + (hashSeed(n) % 190) };
  });
}

export function createFakeCollection(items?: CollectionItem[], source: CollectionList['source'] = 'bundled'): CollectionService {
  return {
    async list() {
      return { source, items: items ?? (await loadBundledCollection()) };
    },
  };
}

// ------------------------------------------------------------------ ord

export interface FakeOrdOptions {
  delayMs?: number;
  /** Ids whose lookup fails. */
  failing?: Set<string>;
  /** Inscriptions held per address (Club). Default: a deterministic mix of members and non-members. */
  holdings?: Record<string, string[]>;
  /** Membership used to build default holdings. */
  members?: () => Promise<CollectionItem[]>;
  log?: string[];
}

export function fakeInscriptionDetails(id: string): InscriptionDetails {
  const h = hashSeed(id);
  const height = 830_000 + (h % 40_000);
  const addr = `bc1p${hex.encode(sha256(new TextEncoder().encode(id))).slice(0, 58)}`;
  return {
    id,
    number: 90_000_000 + (h % 30_000_000),
    address: addr,
    contentType: 'image/jpeg',
    contentLength: 200_000 + (h % 190_000),
    timestamp: new Date(Date.UTC(2024, 1, 1) + (height - 830_000) * 600_000).toISOString(),
    height,
    fee: 20_000 + (h % 80_000),
  };
}

export function createFakeOrd(opts: FakeOrdOptions = {}): OrdService & { calls: string[] } {
  const calls: string[] = opts.log ?? [];
  const cache = new Map<string, Promise<InscriptionDetails>>();
  const get = (id: string) => {
    let p = cache.get(id);
    if (!p) {
      calls.push(`ord.inscription:${id}`);
      p = (async () => {
        if (opts.delayMs) await sleep(opts.delayMs);
        if (opts.failing?.has(id)) throw new Error('ord 503');
        return fakeInscriptionDetails(id);
      })();
      cache.set(id, p);
      p.catch(() => cache.delete(id));
    }
    return p;
  };
  return {
    calls,
    getInscription: get,
    prefetch(id) {
      get(id).catch(() => undefined);
    },
    async getAddressInscriptions(address) {
      calls.push(`ord.address:${address}`);
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.holdings) return opts.holdings[address] ?? [];
      const members = await (opts.members ?? loadBundledCollection)();
      const h = hashSeed(address);
      const picks = [0, 1, 2].map((k) => members[(h + k * 977) % members.length]!.id);
      // plus one inscription that is NOT a Degent (must be filtered out by the intersection)
      return [...picks, `${'ab'.repeat(32)}i0`];
    },
    contentUrl: (id) => `demo:content/${id}`,
    inscriptionUrl: (id) => `https://ordinals.com/inscription/${id}`,
  };
}

// ------------------------------------------------------------------ newsletter

export function createFakeNewsletter(opts: { configured?: boolean; delayMs?: number; log?: string[] } = {}): NewsletterService {
  const seen = new Set<string>();
  return {
    configured: opts.configured ?? true,
    async subscribe(req) {
      opts.log?.push(`newsletter:${req.email}`);
      if (opts.delayMs) await sleep(opts.delayMs);
      const invalid = validateNewsletter(req);
      if (invalid) return { ok: false, message: invalid };
      const email = req.email.trim().toLowerCase();
      if (email.includes('fail')) return { ok: false, message: 'The newsletter service is unavailable (HTTP 503). Please try again later.' };
      if (seen.has(email) || email.startsWith('member@')) return { ok: true, alreadySubscribed: true };
      seen.add(email);
      return { ok: true, alreadySubscribed: false };
    },
  };
}

// ------------------------------------------------------------------ atelier

/** Byte target the fake compositor aims at inside each tier. */
export const FAKE_TIER_TARGET: Record<Tier, number> = { standard: 312_345, large: 1_234_567, fullblock: 3_600_000 };

export interface RenderArgs {
  seed: string;
  tier: Tier;
  placard: Placard | null;
  frame: boolean;
  source?: Blob;
  targetBytes: number;
}

export interface FakeAtelierOptions {
  configured?: boolean;
  providerMode?: 'fake' | 'live';
  dailyImages?: number;
  usedToday?: number;
  /** getJob polls reported as queued/running before `done`. */
  pollsUntilDone?: number;
  failJobs?: boolean;
  /** Thrown by generate (e.g. rate limit, cost cap). */
  generateError?: AtelierError;
  /** Produces the finalised JPEG bytes. Default: header-only synthetic JPEG (tests). */
  render?: (args: RenderArgs) => Promise<Uint8Array>;
  delayMs?: number;
  log?: string[];
}

const CONFIG: AtelierConfig = {
  tiers: (['standard', 'large', 'fullblock'] as Tier[]).map((tier) => {
    const r = { standard: [200_000, 400_000], large: [400_001, 3_499_999], fullblock: [3_500_000, 3_900_000] }[tier];
    return { tier, label: TIER_LABELS[tier], minBytes: r[0]!, maxBytes: r[1]! };
  }),
  placards: ['DEGEN', 'DEGENT', 'REGEN'],
  maxVariations: 4,
  maxUploadBytes: 8 * 1024 * 1024,
  sessionDailyImages: 12,
};

export function rulesReview(bytes: Uint8Array, tier: Tier, placard: Placard | null, framed: boolean): AtelierReview {
  const info = readImageInfo(bytes);
  const t = tierForSize(bytes.length);
  const range = CONFIG.tiers.find((x) => x.tier === tier)!;
  const checks = [
    { id: 'magic_bytes', passed: sniffContentType(bytes) === 'image/jpeg', detail: `header says ${sniffContentType(bytes) ?? 'unknown'}` },
    { id: 'square', passed: !!info?.width && info.width === info.height, detail: `${info?.width ?? '?'}×${info?.height ?? '?'} px` },
    {
      id: 'dimensions',
      passed: !!info?.width && info.width >= 256 && info.width <= 4096,
      detail: 'between 256 and 4096 px',
    },
    {
      id: 'size',
      passed: bytes.length >= range.minBytes && bytes.length <= range.maxBytes,
      detail: `${bytes.length.toLocaleString('en-US')} bytes (${range.label}: ${range.minBytes.toLocaleString('en-US')}–${range.maxBytes.toLocaleString('en-US')})`,
    },
    { id: 'tier', passed: t?.tier === tier, detail: t ? `bytes fit ${t.label}` : 'bytes fit no tier' },
    { id: 'placard', passed: !framed || placard !== null, detail: framed ? `frame with ${placard ?? 'no'} placard drawn by the compositor` : 'your own frame and placard' },
  ];
  const reasons = checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  return { approved: reasons.length === 0, reasons, checks };
}

export function createFakeAtelier(opts: FakeAtelierOptions = {}): AtelierService & { contents: Map<string, Uint8Array>; log: string[] } {
  const log = opts.log ?? [];
  const contents = new Map<string, Uint8Array>();
  const jobs = new Map<string, { job: AtelierJob; polls: number }>();
  const quota: AtelierQuota = { dailyImages: opts.dailyImages ?? CONFIG.sessionDailyImages, usedToday: opts.usedToday ?? 0 };
  let session = false;
  let seq = 0;
  const render =
    opts.render ??
    (async (a: RenderArgs) => {
      const edge = a.tier === 'standard' ? 1024 : a.tier === 'large' ? 2048 : 3072;
      return syntheticJpeg(edge, edge, a.targetBytes, hashSeed(a.seed));
    });
  const configured = opts.configured ?? true;
  const guard = () => {
    if (!configured) throw new AtelierError('not_configured', 'The Atelier is not configured on this site.');
  };
  const delay = async () => {
    if (opts.delayMs) await sleep(opts.delayMs);
  };
  const store = (bytes: Uint8Array): string => {
    const sha = hex.encode(sha256(bytes));
    contents.set(sha, bytes);
    return sha;
  };

  return {
    configured,
    contents,
    log,
    async health() {
      guard();
      log.push('atelier.health');
      return {
        status: 'ok',
        provider: { name: (opts.providerMode ?? 'fake') === 'fake' ? 'fake' : 'openai:gpt-image-1', mode: opts.providerMode ?? 'fake' },
        queueDepth: 0,
        spentTodayCents: 0,
        dailyCostCapCents: 5000,
      };
    },
    async config() {
      guard();
      return { ...CONFIG, sessionDailyImages: quota.dailyImages };
    },
    async ensureSession() {
      guard();
      if (!session) log.push('atelier.session');
      session = true;
      return { ...quota };
    },
    async generate(req) {
      guard();
      await delay();
      log.push(`atelier.generate:${req.variations}`);
      if (opts.generateError) throw opts.generateError;
      if (/https?:|www\./i.test(req.brief)) {
        throw new AtelierError('validation_failed', 'Links are not allowed in the brief.', 400, null, { problems: ['brief: links are refused'] });
      }
      if (quota.usedToday + req.variations > quota.dailyImages) {
        throw new AtelierError(
          'quota_exceeded',
          `Daily image quota reached (${quota.usedToday} of ${quota.dailyImages} used). It resets at 00:00 UTC.`,
          429,
        );
      }
      quota.usedToday += req.variations;
      const id = `job_${String(++seq).padStart(6, '0')}`;
      const job: AtelierJob = {
        id,
        status: 'queued',
        tier: req.tier,
        placard: req.placard,
        brief: req.brief,
        variations: req.variations,
        provider: opts.providerMode === 'live' ? 'openai:gpt-image-1' : 'fake',
        error: null,
        candidates: [],
      };
      jobs.set(id, { job, polls: 0 });
      return { jobId: id, quota: { ...quota } };
    },
    async getJob(jobId) {
      guard();
      await delay();
      const entry = jobs.get(jobId);
      if (!entry) throw new AtelierError('not_found', 'Job not found.', 404);
      entry.polls++;
      const until = opts.pollsUntilDone ?? 2;
      const { job } = entry;
      if (job.status === 'done' || job.status === 'failed') return job;
      if (entry.polls >= until) {
        if (opts.failJobs) {
          job.status = 'failed';
          job.error = { code: 'provider_unavailable', message: 'The image provider is unavailable right now. Your quota was refunded.' };
          quota.usedToday = Math.max(0, quota.usedToday - job.variations);
        } else {
          job.status = 'done';
          job.candidates = Array.from({ length: job.variations }, (_, i): AtelierCandidate => {
            const cid = `cand_${job.id}_${i + 1}`;
            return {
              id: cid,
              previewUrl: gentlemanDataUrl(`${job.brief}|${i}`),
              width: 512,
              height: 512,
              providerRef: `fake:${i}`,
              review: null,
            };
          });
        }
      } else {
        job.status = entry.polls === 1 ? 'queued' : 'running';
      }
      log.push(`atelier.job:${job.status}`);
      return { ...job, candidates: [...job.candidates] };
    },
    async finalize(candidateId, req) {
      guard();
      await delay();
      log.push(`atelier.finalize:${candidateId}`);
      const bytes = await render({ seed: candidateId, tier: req.tier, placard: req.placard, frame: true, targetBytes: FAKE_TIER_TARGET[req.tier] });
      const sha = store(bytes);
      const info = readImageInfo(bytes);
      const review = rulesReview(bytes, req.tier, req.placard, true);
      if (!review.approved) throw new AtelierError('review_rejected', review.reasons.join('; '), 422);
      const out: FinalizedContent = {
        tier: req.tier,
        placard: req.placard,
        contentSha256: sha,
        contentLength: bytes.length,
        contentType: 'image/jpeg',
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        review,
        downloadUrl: `/v1/content/${sha}`,
      };
      return out;
    },
    async upload(file, o) {
      guard();
      await delay();
      log.push(`atelier.upload:${o.frame ? 'frame' : 'as-is'}`);
      if (file.size > CONFIG.maxUploadBytes) throw new AtelierError('payload_too_large', 'Uploads are limited to 8 MiB.', 413);
      const raw = new Uint8Array(await file.arrayBuffer());
      const kind = sniffContentType(raw);
      if (!kind) throw new AtelierError('unsupported_media_type', 'That file is not a PNG, JPEG, WebP, AVIF or GIF image.', 415);
      if (o.frame && !o.placard) throw new AtelierError('validation_failed', 'Choose a placard for the frame.', 400);
      const bytes = await render({
        seed: `upload|${raw.length}|${hex.encode(sha256(raw)).slice(0, 12)}`,
        tier: o.tier,
        placard: o.placard,
        frame: o.frame,
        source: file,
        targetBytes: FAKE_TIER_TARGET[o.tier],
      });
      const sha = store(bytes);
      const info = readImageInfo(bytes);
      return {
        tier: o.tier,
        placard: o.frame ? o.placard : null,
        contentSha256: sha,
        contentLength: bytes.length,
        contentType: 'image/jpeg',
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        review: rulesReview(bytes, o.tier, o.placard, o.frame),
        downloadUrl: `/v1/content/${sha}`,
        transformed: true,
      };
    },
    async getContent(sha) {
      guard();
      await delay();
      log.push(`atelier.content:${sha.slice(0, 8)}`);
      const b = contents.get(sha);
      if (!b) throw new AtelierError('not_found', 'Content not found.', 404);
      return b.slice();
    },
  };
}

// ------------------------------------------------------------------ bundle

export interface FakeSiteOptions {
  stats?: CollectionStats | Error;
  items?: CollectionItem[];
  ord?: FakeOrdOptions;
  atelier?: FakeAtelierOptions;
  newsletter?: { configured?: boolean; delayMs?: number };
  log?: string[];
}

export function createFakeSiteServices(o: FakeSiteOptions = {}): SiteServices & { log: string[] } {
  const log = o.log ?? [];
  const collection = createFakeCollection(o.items);
  return {
    mode: 'demo',
    log,
    stats: o.stats ? createFakeStats(o.stats) : { getStats: bundledStats },
    collection,
    ord: createFakeOrd({ members: async () => (await collection.list()).items, ...o.ord, log }),
    newsletter: createFakeNewsletter({ ...o.newsletter, log }),
    atelier: createFakeAtelier({ ...o.atelier, log }),
  };
}
