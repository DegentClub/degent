/**
 * The review queue and the only path to X. Every draft goes through `gateContent`; it posts on its own only when
 * the tier is auto AND the review queue is explicitly disabled (REVIEW_QUEUE_ENABLED=false) AND the safety checks
 * pass. Everything else waits for a named human (`approve`), and is checked again when it posts (`postable`).
 */
import { postable, selectPostable } from '../content/approval.js';
import { gateContent } from '../content/safety.js';
import type { Draft, DraftKind, DraftStore } from '../ports/draft-store.js';
import type { XClient } from '../ports/x-client.js';
import { silentLogger, type Logger } from './logger.js';

export interface PublisherSettings {
  /** Default true. Only an explicit `false` lets auto-tier drafts post without a human. */
  reviewQueueEnabled: boolean;
  /** Master switch for any posting (auto or approved). Default false: drafts only. */
  postingEnabled: boolean;
}

export interface SubmitInput {
  kind: DraftKind;
  dedupeKey: string;
  text: string;
  contentType?: string;
}

export type SubmitResult = { draft: Draft; created: boolean; posted: boolean };

export class Publisher {
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly d: { store: DraftStore; x: XClient; settings: PublisherSettings; now?: () => number; log?: Logger },
  ) {
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? Date.now;
  }

  get settings(): PublisherSettings {
    return this.d.settings;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const gate = gateContent(input.text, {
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      reviewQueueEnabled: this.d.settings.reviewQueueEnabled,
    });
    const { draft, created } = await this.d.store.add({
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      text: gate.text,
      tier: gate.tier,
      reasons: gate.reasons,
      safetyFailures: gate.safety.failures,
      status: gate.status,
      createdAt: new Date(this.now()).toISOString(),
      approvedBy: null,
      decidedAt: null,
      postedId: null,
      error: null,
    });
    if (!created) return { draft, created, posted: false };
    this.log.info('x-bot: draft queued', { id: draft.id, kind: draft.kind, tier: draft.tier, reasons: draft.reasons, status: draft.status, safetyFailures: draft.safetyFailures });
    if (!gate.autoPost || !this.d.settings.postingEnabled) return { draft, created, posted: false };
    const posted = await this.post(draft);
    return { draft: posted, created, posted: posted.status === 'posted' };
  }

  /** A human approves a pending draft. Unsafe text (e.g. an address) cannot be approved by anyone. */
  async approve(id: string, approvedBy: string): Promise<Draft> {
    if (!approvedBy.trim()) throw new Error('approve: approvedBy is required');
    const d = await this.mustGet(id);
    if (d.status !== 'pending') throw new Error(`approve: draft ${id} is ${d.status}`);
    if (d.safetyFailures.length > 0) throw new Error(`approve: draft ${id} fails safety checks (${d.safetyFailures.join(', ')})`);
    return this.d.store.update(id, { status: 'approved', approvedBy: approvedBy.trim(), decidedAt: new Date(this.now()).toISOString() });
  }

  async reject(id: string, by: string): Promise<Draft> {
    const d = await this.mustGet(id);
    if (d.status !== 'pending' && d.status !== 'approved') throw new Error(`reject: draft ${id} is ${d.status}`);
    return this.d.store.update(id, { status: 'rejected', approvedBy: by, decidedAt: new Date(this.now()).toISOString() });
  }

  /** Post every approved draft that passes the approval-tier rules; refuse (and log) the rest. */
  async publishApproved(): Promise<{ posted: string[]; refused: Array<{ id: string; reason: string }>; failed: string[] }> {
    const out = { posted: [] as string[], refused: [] as Array<{ id: string; reason: string }>, failed: [] as string[] };
    if (!this.d.settings.postingEnabled) return out;
    const { eligible, refused } = selectPostable(await this.d.store.list('approved'));
    for (const r of refused) this.log.warn('x-bot: refusing to post an approved draft', r);
    out.refused = refused;
    for (const d of eligible) {
      const p = await this.post(d);
      (p.status === 'posted' ? out.posted : out.failed).push(d.id);
    }
    return out;
  }

  private async post(d: Draft): Promise<Draft> {
    const v = postable(d);
    if (!v.ok) throw new Error(`post: draft ${d.id} is not postable (${v.reason})`);
    try {
      const { id } = await this.d.x.post(d.text);
      this.log.info('x-bot: posted', { id: d.id, postId: id, tier: d.tier });
      return this.d.store.update(d.id, { status: 'posted', postedId: id, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.error('x-bot: post failed', { id: d.id, error });
      return this.d.store.update(d.id, { status: 'failed', error });
    }
  }

  private async mustGet(id: string): Promise<Draft> {
    const d = await this.d.store.get(id);
    if (!d) throw new Error(`no draft ${id}`);
    return d;
  }
}
