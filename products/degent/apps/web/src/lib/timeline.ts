/** ADR-0002 §6 order state machine plus the member-approval stage of ADR-0007, as presented to the user. */
import type { Order, OrderEvent, OrderStatus } from '@bsh/degent-mint-sdk';

export const HAPPY_PATH: readonly OrderStatus[] = [
  'awaiting_content',
  'reviewing',
  'approved',
  'awaiting_payment',
  'paid',
  'confirming',
  'member_review',
  'queued',
  'revealing',
  'revealed',
  'confirmed',
  'verified',
  'delivered',
];

export const OFF_PATH: readonly OrderStatus[] = ['rejected', 'expired', 'declined', 'rescue_available', 'failed'];

export const STATUS_COPY: Record<OrderStatus, { label: string; blurb: string }> = {
  awaiting_content: { label: 'Order opened', blurb: 'Waiting for your artwork bytes.' },
  reviewing: { label: 'Art review', blurb: 'The automated doorman is inspecting the art.' },
  approved: { label: 'Approved', blurb: 'The art meets the brief. Nothing is payable before this.' },
  rejected: { label: 'Rejected', blurb: 'The art did not meet the brief. You have paid nothing.' },
  awaiting_payment: { label: 'Awaiting payment', blurb: 'Half-signed reveal stored. Waiting for your funding transaction.' },
  paid: { label: 'Payment seen', blurb: 'Your funding (commit) transaction is on the network.' },
  confirming: { label: 'Confirming', blurb: 'Waiting for the funding transaction to be mined before the members see it.' },
  member_review: { label: 'Member review', blurb: 'Existing club members are voting on your Degent.' },
  declined: { label: 'Declined by the members', blurb: 'The club said no. You keep your inscription — reveal it without the parent link below.' },
  queued: { label: 'Approved · queued', blurb: 'The members approved. Waiting for its lane. Block Degents take a whole block each.' },
  revealing: { label: 'Revealing', blurb: 'The parent is being attached and co-signed.' },
  revealed: { label: 'Revealed', blurb: 'The reveal transaction is in the mempool.' },
  confirmed: { label: 'Confirmed', blurb: 'Mined into a block.' },
  verified: { label: 'Verified', blurb: 'On-chain bytes hash-match what you previewed.' },
  delivered: { label: 'Delivered', blurb: 'The Degent sits in your ordinals address. Welcome to the club.' },
  expired: { label: 'Expired', blurb: 'The quote lapsed before payment. Nothing was spent.' },
  rescue_available: { label: 'Rescue available', blurb: 'The service has not revealed in time. You can reveal it yourself.' },
  failed: { label: 'Failed', blurb: 'Something went wrong. See the detail below.' },
};

// ---------------------------------------------------------------- the four stages (ADR-0007)

export type Stage = 'design' | 'mint' | 'confirm' | 'approve';
export const STAGES: readonly Stage[] = ['design', 'mint', 'confirm', 'approve'];
export const STAGE_COPY: Record<Stage, { label: string; blurb: string }> = {
  design: { label: 'Design', blurb: 'Art in the brief, checked by the automated doorman before anything is payable.' },
  mint: { label: 'Mint', blurb: 'Your reveal is pre-signed in the browser; you fund the commit with your own wallet.' },
  confirm: { label: 'Confirm', blurb: 'The funding transaction is mined. Only then do the members see it.' },
  approve: { label: 'Approve', blurb: 'Existing members vote. On quorum the club co-signs the parent link and reveals your Degent.' },
};

const STAGE_OF: Record<OrderStatus, Stage> = {
  awaiting_content: 'design',
  reviewing: 'design',
  approved: 'design',
  rejected: 'design',
  awaiting_payment: 'mint',
  paid: 'mint',
  expired: 'mint',
  failed: 'mint',
  confirming: 'confirm',
  member_review: 'approve',
  declined: 'approve',
  queued: 'approve',
  revealing: 'approve',
  revealed: 'approve',
  confirmed: 'approve',
  verified: 'approve',
  delivered: 'approve',
  rescue_available: 'approve',
};

export function stageOf(status: OrderStatus): Stage {
  return STAGE_OF[status];
}

export interface StageStep {
  stage: Stage;
  label: string;
  blurb: string;
  state: StepState;
}

/** The four-stage strip: done before the current stage, current, upcoming after; `problem` on an off-path status. */
export function buildStages(order: Pick<Order, 'status'>): StageStep[] {
  const cur = STAGES.indexOf(stageOf(order.status));
  const offPath = OFF_PATH.includes(order.status);
  const finished = order.status === 'delivered';
  return STAGES.map((stage, i) => ({
    stage,
    ...STAGE_COPY[stage],
    state: i < cur || (i === cur && finished) ? 'done' : i === cur ? (offPath ? 'problem' : 'current') : 'upcoming',
  }));
}

export type StepState = 'done' | 'current' | 'upcoming' | 'problem';

export interface TimelineStep {
  status: OrderStatus;
  label: string;
  blurb: string;
  state: StepState;
  event?: OrderEvent;
}

export function isTerminal(status: OrderStatus): boolean {
  return status === 'delivered' || status === 'rejected' || status === 'expired' || status === 'failed';
}

export function isPrePaid(status: OrderStatus): boolean {
  return ['awaiting_content', 'reviewing', 'approved', 'awaiting_payment'].includes(status);
}

/** Self-rescue is offered right now (timeout, policy refusal, or the members declined). */
export function rescueOffered(status: OrderStatus): boolean {
  return status === 'rescue_available' || status === 'declined';
}

/** Last event per status. */
function lastEvents(timeline: OrderEvent[]): Map<OrderStatus, OrderEvent> {
  const m = new Map<OrderStatus, OrderEvent>();
  for (const e of timeline) m.set(e.status, e);
  return m;
}

/**
 * Steps for the stepper. The happy path is always shown; an off-path status (rejected, expired,
 * declined, rescue_available, failed) is inserted after the last happy step reached, marked `problem`.
 */
export function buildTimeline(order: Pick<Order, 'status' | 'timeline'>): TimelineStep[] {
  const events = lastEvents(order.timeline);
  const offPath = OFF_PATH.includes(order.status);
  let reachedIdx = HAPPY_PATH.indexOf(order.status);
  if (offPath) {
    reachedIdx = -1;
    HAPPY_PATH.forEach((s, i) => {
      if (events.has(s)) reachedIdx = i;
    });
  }
  const steps: TimelineStep[] = HAPPY_PATH.map((status, i) => {
    const state: StepState =
      i < reachedIdx || (i === reachedIdx && (offPath || order.status === 'delivered'))
        ? 'done'
        : i === reachedIdx
          ? 'current'
          : 'upcoming';
    const step: TimelineStep = { status, ...STATUS_COPY[status], state };
    const ev = events.get(status);
    if (ev) step.event = ev;
    return step;
  });
  if (offPath) {
    const problem: TimelineStep = { status: order.status, ...STATUS_COPY[order.status], state: 'problem' };
    const ev = events.get(order.status);
    if (ev) problem.event = ev;
    steps.splice(reachedIdx + 1, 0, problem);
  }
  return steps;
}
