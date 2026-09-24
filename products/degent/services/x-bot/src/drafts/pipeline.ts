/**
 * Events and stats -> draft posts. Consumes the platform topic `degent.mint.order.delivered` (@bsh/events,
 * deps/scribbit/contracts/asyncapi/platform-events.yaml) and the Register's `/v1/stats`; states only facts it read
 * from the Register; hands every text to the Publisher, which classifies it (member and milestone drafts carry
 * numbers, so they are review tier and wait for a human).
 */
import { degentMintOrder, idempotent, type DedupeStore, type EventBus, type MintOrderStatusChanged, type Subscription } from '@bsh/events';
import type { StatsResponse } from '@bsh/degent-mint-sdk';
import type { Publisher, SubmitResult } from '../application/publisher.js';
import { silentLogger, type Logger } from '../application/logger.js';
import type { RegisterReader } from '../ports/register-reader.js';
import { memberJoinedText, milestoneText, weeklyText } from './templates.js';

export const DELIVERED_TOPIC = degentMintOrder.typeFor({ status: 'delivered' });
const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface DraftPipelineOptions {
  register: RegisterReader;
  publisher: Publisher;
  /** Draft a milestone every N members (default 100). */
  milestoneEvery?: number;
  now?: () => number;
  log?: Logger;
}

export class DraftPipeline {
  private readonly every: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly o: DraftPipelineOptions) {
    this.every = o.milestoneEvery ?? 100;
    if (!Number.isSafeInteger(this.every) || this.every < 1) throw new Error('milestoneEvery must be a positive integer');
    this.now = o.now ?? Date.now;
    this.log = o.log ?? silentLogger;
  }

  /** A delivered, parent-linked child -> "Degent #n joined the Club." Other statuses and non-members: no draft. */
  async onOrderStatus(e: MintOrderStatusChanged): Promise<SubmitResult | null> {
    if (e.status !== 'delivered' || !e.inscriptionId) return null;
    const v = await this.o.register.registerVerify(e.inscriptionId);
    if (!v.member || v.n === null) {
      this.log.warn('x-bot: delivered inscription is not in the Register yet; no draft', { orderId: e.orderId, inscriptionId: e.inscriptionId });
      return null;
    }
    const m = await this.o.register.registerMember(v.n);
    return this.o.publisher.submit({ kind: 'member_joined', dedupeKey: `member:${m.n}`, text: memberJoinedText(m) });
  }

  /** Milestone (every N members) and last-complete-week drafts from `/v1/stats`. Idempotent per milestone / week. */
  async fromStats(stats?: StatsResponse): Promise<SubmitResult[]> {
    const s = stats ?? (await this.o.register.stats());
    const out: SubmitResult[] = [];
    const milestone = Math.floor(s.minted / this.every) * this.every;
    if (milestone > 0)
      out.push(await this.o.publisher.submit({ kind: 'milestone', dedupeKey: `milestone:${milestone}`, text: milestoneText({ milestone, charter: s.charter, totalBytes: s.totalBytes }) }));
    const complete = s.mintsPerWeek.filter((w) => Date.parse(`${w.week}T00:00:00Z`) + WEEK_MS <= this.now() && w.count > 0);
    const last = complete.at(-1);
    if (last)
      out.push(
        await this.o.publisher.submit({
          kind: 'weekly',
          dedupeKey: `week:${last.week}`,
          text: weeklyText({ count: last.count, medianBytes: s.medianBytes, minted: s.minted, charter: s.charter }),
        }),
      );
    return out;
  }

  /** Subscribe to `degent.mint.order.delivered` (at-least-once; de-duplicated per event and per Degent number). */
  attach(bus: EventBus, opts: { name?: string; dedupe?: DedupeStore } = {}): Promise<Subscription> {
    return bus.subscribe<MintOrderStatusChanged>(
      DELIVERED_TOPIC,
      idempotent(async (event) => {
        await this.onOrderStatus(event.data);
      }, opts.dedupe),
      { name: opts.name ?? 'degent-x-bot.drafts' },
    );
  }
}
