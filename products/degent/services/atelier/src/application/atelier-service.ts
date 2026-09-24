/**
 * Use cases behind the HTTP API: anonymous sessions with a daily generation quota and a global daily
 * cost cap, async generation jobs (in-memory queue, worker with a deterministic `tick()`), candidate
 * finalisation through the compositor, and the bring-your-own-art upload path. The HTTP layer only
 * parses, authenticates and maps errors.
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { compose, ComposeError, dimensions, preview, type ComposeResult } from '../compose.js';
import { AtelierError, ProviderError, validation } from '../domain/errors.js';
import { ACCEPTED_UPLOAD_TYPES, MAX_VARIATIONS, isPlacard, isTier, tierForSize, type Placard, type Tier } from '../domain/tiers.js';
import { readImageInfo } from '../image-info.js';
import { scaffoldPrompt, validateBrief } from '../prompt.js';
import type { ImageProvider } from '../providers/image-provider.js';
import type { ArtReview, ReviewResult } from '../review.js';
import type { ContentStore } from '../adapters/content-store.js';
import type { SessionRecord, StateStore } from '../adapters/state-store.js';
import type { Logger } from './logger.js';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface Quotas {
  /** Images a session may generate per UTC day. */
  sessionDailyImages: number;
  /** Global provider spend cap per UTC day, US cents. 0 disables generation entirely. */
  globalDailyCostCents: number;
  /** Sessions one IP may create per UTC day. */
  sessionsPerIpPerDay: number;
  sessionTtlHours: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Candidate {
  id: string;
  jobId: string;
  sessionId: string;
  /** Source bytes as returned by the provider (content store key). */
  sourceSha256: string;
  sourceMime: string;
  previewSha256: string;
  width: number;
  height: number;
  providerRef: string;
  review: ReviewResult | null;
}

export interface Job {
  id: string;
  sessionId: string;
  status: JobStatus;
  brief: string;
  palette: string | null;
  mood: string | null;
  placard: Placard;
  tier: Tier;
  variations: number;
  prompt: string;
  provider: string;
  ledgerId: string;
  candidateIds: string[];
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface FinalizeResult {
  candidateId: string;
  tier: Tier;
  placard: Placard;
  contentSha256: string;
  contentLength: number;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  encoding: ComposeResult['encoding'];
  review: ReviewResult;
}

export interface UploadResult {
  uploadId: string;
  framed: boolean;
  /** False when the upload was already compliant and stored byte-for-byte. */
  transformed: boolean;
  tier: Tier;
  placard: Placard | null;
  contentSha256: string;
  contentLength: number;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  review: ReviewResult;
}

export interface AtelierDeps {
  provider: ImageProvider;
  /** Optional reviewer applied to generated candidates (vision only: a raw candidate is not yet mint-sized). */
  candidateReview: ArtReview | null;
  /** Reviewer applied to finalised / uploaded bytes (rules, plus vision when configured). */
  outputReview: ArtReview;
  content: ContentStore;
  state: StateStore;
  quotas: Quotas;
  clock?: Clock;
  log?: Logger;
  /** Max concurrent provider calls in the worker. */
  concurrency?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const newId = (bytes = 12) => randomBytes(bytes).toString('base64url');
export const hashToken = (token: string) => bytesToHex(sha256(new TextEncoder().encode(token)));
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export class AtelierService {
  private readonly jobs = new Map<string, Job>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly concurrency: number;

  constructor(readonly deps: AtelierDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? { info() {}, warn() {}, error() {} };
    this.concurrency = deps.concurrency ?? 2;
  }

  // ---- sessions -------------------------------------------------------------------------------

  async createSession(ip: string): Promise<{ session: SessionRecord; token: string; quota: { dailyImages: number; usedToday: number } }> {
    const now = this.clock.now();
    const q = this.deps.quotas;
    const made = await this.deps.state.countSessionsByIpSince(ip, dayStart(now));
    if (made >= q.sessionsPerIpPerDay) throw new AtelierError(429, 'quota_exceeded', 'too many sessions created from this address today');
    const token = `atl_${randomBytes(32).toString('base64url')}`;
    const session: SessionRecord = {
      id: newId(),
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + q.sessionTtlHours * 3_600_000).toISOString(),
      ip,
    };
    await this.deps.state.createSession(session);
    return { session, token, quota: { dailyImages: q.sessionDailyImages, usedToday: 0 } };
  }

  /** Resolve a bearer token to a live session; null when unknown or expired (never say which). */
  async authenticate(token: string | undefined): Promise<SessionRecord | null> {
    if (!token || !/^atl_[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const s = await this.deps.state.findSessionByTokenHash(hashToken(token));
    if (!s || s.expiresAt <= this.clock.now().toISOString()) return null;
    return s;
  }

  async quota(sessionId: string): Promise<{ dailyImages: number; usedToday: number }> {
    const used = await this.deps.state.sessionImagesSince(sessionId, dayStart(this.clock.now()));
    return { dailyImages: this.deps.quotas.sessionDailyImages, usedToday: used };
  }

  // ---- generation jobs ---------------------------------------------------------------------------

  async createJob(session: SessionRecord, input: { brief: unknown; palette?: unknown; mood?: unknown; placard: unknown; tier: unknown; variations?: unknown; seed?: unknown }): Promise<Job> {
    const problems: string[] = [];
    if (typeof input.brief !== 'string') problems.push('brief must be a string');
    if (input.palette !== undefined && input.palette !== null && typeof input.palette !== 'string') problems.push('palette must be a string');
    if (input.mood !== undefined && input.mood !== null && typeof input.mood !== 'string') problems.push('mood must be a string');
    if (!isPlacard(input.placard)) problems.push('placard must be one of DEGEN, DEGENT, REGEN');
    if (!isTier(input.tier)) problems.push('tier must be one of standard, large, fullblock');
    const variations = input.variations === undefined ? 1 : input.variations;
    if (!Number.isInteger(variations) || (variations as number) < 1 || (variations as number) > MAX_VARIATIONS) problems.push(`variations must be an integer 1..${MAX_VARIATIONS}`);
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || (input.seed as number) < 0 || (input.seed as number) > 0xffffffff)) problems.push('seed must be an integer 0..4294967295');
    if (problems.length === 0) {
      const v = validateBrief({ brief: input.brief as string, palette: (input.palette as string | undefined) ?? undefined, mood: (input.mood as string | undefined) ?? undefined });
      problems.push(...v.problems);
    }
    if (problems.length) throw validation('invalid generation request', { problems });

    const n = variations as number;
    const now = this.clock.now();
    const q = this.deps.quotas;
    const since = dayStart(now);
    const used = await this.deps.state.sessionImagesSince(session.id, since);
    if (used + n > q.sessionDailyImages) throw new AtelierError(429, 'quota_exceeded', `daily generation quota is ${q.sessionDailyImages} images per session (${used} used)`);
    const cost = this.deps.provider.estimateCostCents({ n, size: '1024x1024' });
    const spent = await this.deps.state.costCentsSince(since);
    if (spent + cost > q.globalDailyCostCents) throw new AtelierError(503, 'cost_cap_reached', 'the Atelier has reached its daily budget; try again tomorrow');

    const scaffold = scaffoldPrompt({ brief: input.brief as string, palette: (input.palette as string | undefined) ?? undefined, mood: (input.mood as string | undefined) ?? undefined });
    const job: Job = {
      id: newId(),
      sessionId: session.id,
      status: 'queued',
      brief: scaffold.brief,
      palette: scaffold.palette,
      mood: scaffold.mood,
      placard: input.placard as Placard,
      tier: input.tier as Tier,
      variations: n,
      prompt: scaffold.prompt,
      provider: this.deps.provider.name,
      ledgerId: newId(),
      candidateIds: [],
      error: null,
      createdAt: now.toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    // Reserve the spend before the provider call so concurrent jobs cannot overshoot the cap.
    await this.deps.state.record({ id: job.ledgerId, sessionId: session.id, kind: 'generate', images: n, costCents: cost, status: 'reserved', provider: this.deps.provider.name, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    (job as Job & { seed?: number }).seed = input.seed as number | undefined;
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.log.info('job queued', { jobId: job.id, sessionId: session.id, tier: job.tier, variations: n, costCents: cost });
    return job;
  }

  getJob(session: SessionRecord, id: string): Job | null {
    const j = this.jobs.get(id);
    return j && j.sessionId === session.id ? j : null;
  }

  candidatesOf(job: Job): Candidate[] {
    return job.candidateIds.map((id) => this.candidates.get(id)!).filter(Boolean);
  }

  getCandidate(id: string): Candidate | null {
    return this.candidates.get(id) ?? null;
  }

  /** Start as many queued jobs as concurrency allows; resolves when they have all finished. Deterministic for tests. */
  async tick(): Promise<number> {
    const started: Promise<void>[] = [];
    while (this.running < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running++;
      started.push(this.run(job).finally(() => this.running--));
    }
    await Promise.all(started);
    return started.length;
  }

  /** Background loop for main.ts. */
  async runWorker(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        this.log.error('worker tick failed', { error: e instanceof Error ? e.message : String(e) });
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }

  get queueDepth(): number {
    return this.queue.length + this.running;
  }

  private async run(job: Job): Promise<void> {
    job.status = 'running';
    job.startedAt = this.clock.now().toISOString();
    const seed = (job as Job & { seed?: number }).seed;
    try {
      const images = await this.deps.provider.generate({ prompt: job.prompt, negative: scaffoldPrompt({ brief: job.brief, palette: job.palette ?? undefined, mood: job.mood ?? undefined }).negative, size: '1024x1024', n: job.variations, ...(seed !== undefined ? { seed } : {}) });
      for (const img of images) {
        const info = readImageInfo(img.bytes);
        if (!info) {
          this.log.warn('provider returned undecodable bytes', { jobId: job.id, provider: this.deps.provider.name });
          continue;
        }
        const sourceSha256 = await this.deps.content.put(img.bytes);
        const pv = await preview(img.bytes);
        const previewSha256 = await this.deps.content.put(pv);
        const dims = await dimensions(img.bytes);
        let review: ReviewResult | null = null;
        if (this.deps.candidateReview) try {
          review = await this.deps.candidateReview.review({ refId: job.id, declaredContentType: info.contentType, bytes: img.bytes });
        } catch (e) {
          this.log.warn('candidate review unavailable', { jobId: job.id, error: e instanceof Error ? e.message : String(e) });
        }
        const cand: Candidate = { id: newId(), jobId: job.id, sessionId: job.sessionId, sourceSha256, sourceMime: info.contentType, previewSha256, width: dims.width, height: dims.height, providerRef: img.providerRef, review };
        this.candidates.set(cand.id, cand);
        job.candidateIds.push(cand.id);
      }
      if (job.candidateIds.length === 0) throw new ProviderError('image provider returned no usable images', 'no decodable images', true);
      job.status = 'done';
      await this.deps.state.settle(job.ledgerId, { status: 'settled', costCents: this.deps.provider.estimateCostCents({ n: job.candidateIds.length, size: '1024x1024' }), updatedAt: this.clock.now().toISOString() });
      this.log.info('job done', { jobId: job.id, candidates: job.candidateIds.length });
    } catch (e) {
      job.status = 'failed';
      const isProv = e instanceof ProviderError;
      job.error = { code: isProv ? 'provider_unavailable' : 'job_failed', message: isProv ? e.message : 'generation failed' };
      await this.deps.state.settle(job.ledgerId, { status: 'failed', costCents: 0, updatedAt: this.clock.now().toISOString() });
      this.log.error('job failed', { jobId: job.id, provider: this.deps.provider.name, internal: isProv ? e.internal : e instanceof Error ? e.message : String(e) });
    } finally {
      job.finishedAt = this.clock.now().toISOString();
    }
  }

  // ---- finalize --------------------------------------------------------------------------------

  async finalize(session: SessionRecord, candidateId: string, input: { tier: unknown; placard: unknown }): Promise<FinalizeResult> {
    const cand = this.candidates.get(candidateId);
    if (!cand || cand.sessionId !== session.id) throw new AtelierError(404, 'not_found', 'candidate not found');
    const problems: string[] = [];
    if (!isTier(input.tier)) problems.push('tier must be one of standard, large, fullblock');
    if (!isPlacard(input.placard)) problems.push('placard must be one of DEGEN, DEGENT, REGEN');
    if (problems.length) throw validation('invalid finalize request', { problems });
    const src = await this.deps.content.get(cand.sourceSha256);
    if (!src) throw new AtelierError(404, 'not_found', 'candidate source no longer available');
    const r = await this.runCompose(src, { tier: input.tier as Tier, placard: input.placard as Placard, frame: true });
    const review = await this.deps.outputReview.review({ refId: cand.id, declaredContentType: 'image/jpeg', bytes: r.bytes, tier: r.tier });
    if (!review.approved) throw new AtelierError(422, 'review_rejected', 'the finalised image failed review', { review });
    const contentSha256 = await this.deps.content.put(r.bytes);
    this.log.info('candidate finalised', { candidateId: cand.id, sha256: contentSha256, bytes: r.contentLength, ...r.encoding });
    return { candidateId: cand.id, tier: r.tier, placard: input.placard as Placard, contentSha256, contentLength: r.contentLength, contentType: 'image/jpeg', width: r.width, height: r.height, encoding: r.encoding, review };
  }

  // ---- upload ----------------------------------------------------------------------------------

  async upload(session: SessionRecord, bytes: Uint8Array, input: { frame: boolean; tier: unknown; placard?: unknown }): Promise<UploadResult> {
    const problems: string[] = [];
    if (!isTier(input.tier)) problems.push('tier must be one of standard, large, fullblock');
    if (input.frame && !isPlacard(input.placard)) problems.push('placard must be one of DEGEN, DEGENT, REGEN when frame is true');
    if (input.placard !== undefined && input.placard !== null && !isPlacard(input.placard)) problems.push('placard must be one of DEGEN, DEGENT, REGEN');
    if (problems.length) throw validation('invalid upload request', { problems });
    const info = readImageInfo(bytes);
    if (!info || !ACCEPTED_UPLOAD_TYPES.includes(info.contentType)) throw new AtelierError(415, 'unsupported_media_type', `upload must be one of ${ACCEPTED_UPLOAD_TYPES.join(', ')}`);
    const uploadId = newId();
    const tier = input.tier as Tier;
    const placard = isPlacard(input.placard) ? input.placard : null;

    // Already compliant and no frame requested: keep the user's bytes exactly as they are.
    const asIs = !input.frame && info.contentType === 'image/jpeg' && info.width !== null && info.width === info.height && tierForSize(bytes.length)?.tier === tier;
    if (asIs) {
      const review = await this.deps.outputReview.review({ refId: uploadId, declaredContentType: 'image/jpeg', bytes, tier });
      if (!review.approved) throw new AtelierError(422, 'review_rejected', 'the upload failed review', { review });
      const contentSha256 = await this.deps.content.put(bytes);
      return { uploadId, framed: false, transformed: false, tier, placard: null, contentSha256, contentLength: bytes.length, contentType: 'image/jpeg', width: info.width!, height: info.height!, review };
    }
    const r = await this.runCompose(bytes, { tier, placard: placard ?? undefined, frame: input.frame, baseSize: Math.min(4096, Math.max(1024, info.width ?? 1024)) });
    const review = await this.deps.outputReview.review({ refId: uploadId, declaredContentType: 'image/jpeg', bytes: r.bytes, tier });
    if (!review.approved) throw new AtelierError(422, 'review_rejected', 'the upload failed review', { review });
    const contentSha256 = await this.deps.content.put(r.bytes);
    this.log.info('upload finalised', { uploadId, sha256: contentSha256, bytes: r.contentLength, framed: input.frame, ...r.encoding });
    return { uploadId, framed: input.frame, transformed: true, tier, placard: input.frame ? placard : null, contentSha256, contentLength: r.contentLength, contentType: 'image/jpeg', width: r.width, height: r.height, review };
  }

  private async runCompose(src: Uint8Array, opts: Parameters<typeof compose>[1]): Promise<ComposeResult> {
    let r: Awaited<ReturnType<typeof compose>>;
    try {
      r = await compose(src, opts);
    } catch (e) {
      if (e instanceof ComposeError) throw new AtelierError(422, 'validation_failed', e.message);
      throw e;
    }
    if (!r.ok) throw new AtelierError(422, 'range_unreachable', r.message, { attempts: r.attempts, tier: opts.tier });
    return r;
  }

  // ---- content ---------------------------------------------------------------------------------

  async content(sha: string): Promise<Uint8Array | null> {
    return this.deps.content.get(sha);
  }

  async health(): Promise<{ status: 'ok' | 'degraded'; provider: { name: string; mode: 'fake' | 'live' }; queueDepth: number; spentTodayCents: number; dailyCostCapCents: number; checks: Array<{ id: string; ok: boolean; detail: string }> }> {
    const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
    let ok = true;
    try {
      await this.deps.state.costCentsSince(dayStart(this.clock.now()));
      checks.push({ id: 'state', ok: true, detail: 'state store reachable' });
    } catch (e) {
      ok = false;
      checks.push({ id: 'state', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    const spent = ok ? await this.deps.state.costCentsSince(dayStart(this.clock.now())) : 0;
    const capLeft = spent < this.deps.quotas.globalDailyCostCents;
    checks.push({ id: 'budget', ok: capLeft, detail: capLeft ? `${spent} of ${this.deps.quotas.globalDailyCostCents} cents spent today` : 'daily cost cap reached; generation paused until 00:00 UTC' });
    const mode = this.deps.provider.name === 'fake' ? 'fake' : 'live';
    checks.push({ id: 'provider', ok: true, detail: mode === 'fake' ? 'no provider key configured: running in fake mode (procedural placeholders)' : `provider ${this.deps.provider.name}` });
    return { status: ok && capLeft ? 'ok' : 'degraded', provider: { name: this.deps.provider.name, mode }, queueDepth: this.queueDepth, spentTodayCents: spent, dailyCostCapCents: this.deps.quotas.globalDailyCostCents, checks };
  }
}
