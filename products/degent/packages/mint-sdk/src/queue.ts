/**
 * Block-lane scheduling maths (ADR-0005 §4), shared by the service (which dispatches) and any UI
 * that wants to explain a queue position. Pure and deterministic.
 *
 * The block lane has a per-block WEIGHT BUDGET (`BLOCK_LANE_WEIGHT_BUDGET`, 3,990,000 WU). Orders
 * are packed into block SLOTS first-come first-served: an order joins the current slot when its
 * weight still fits, otherwise it opens the next slot. A Full Block Degent (`sharesBlock: false`)
 * never shares: it always opens a slot of its own and closes it. Packing is greedy in queue order
 * (no reordering), so nobody is overtaken by a smaller order behind them.
 */
import { BLOCK_LANE_WEIGHT_BUDGET } from './rules.js';

export interface BlockLaneItem {
  id: string;
  /** Exact reveal weight in WU (the quote's `revealWeight`). */
  weight: number;
  /** False for a Full Block Degent. */
  sharesBlock: boolean;
}

export interface BlockSlot {
  /** 1-based slot index; ETA is index x ~10 min. */
  index: number;
  items: BlockLaneItem[];
  weight: number;
}

export interface PackOptions {
  budget?: number;
  /**
   * Items already in flight (revealing / revealed but unconfirmed). They form slot 1; waiting items
   * that still fit its budget join it (the worker dispatches them into the same block).
   */
  inFlight?: BlockLaneItem[];
}

function opens(slot: BlockSlot, item: BlockLaneItem, budget: number): boolean {
  if (slot.items.length === 0) return true;
  if (!item.sharesBlock) return false;
  if (slot.items.some((x) => !x.sharesBlock)) return false;
  return slot.weight + item.weight <= budget;
}

/** Pack `waiting` (in queue order) after `inFlight` into block slots. */
export function packBlockSlots(waiting: BlockLaneItem[], opts: PackOptions = {}): BlockSlot[] {
  const budget = opts.budget ?? BLOCK_LANE_WEIGHT_BUDGET;
  const slots: BlockSlot[] = [];
  const inFlight = opts.inFlight ?? [];
  if (inFlight.length > 0) {
    slots.push({ index: 1, items: [...inFlight], weight: inFlight.reduce((s, x) => s + x.weight, 0) });
  }
  for (const item of waiting) {
    const last = slots[slots.length - 1];
    if (last && opens(last, item, budget)) {
      last.items.push(item);
      last.weight += item.weight;
    } else {
      slots.push({ index: slots.length + 1, items: [item], weight: item.weight });
    }
  }
  return slots;
}

/** 1-based slot index of `id`, or null when it is not queued. */
export function blockSlotOf(slots: BlockSlot[], id: string): number | null {
  const slot = slots.find((s) => s.items.some((x) => x.id === id));
  return slot ? slot.index : null;
}

/**
 * Can `item` be dispatched into the block currently in flight? True when nothing is in flight,
 * or when neither side is a Full Block Degent and the combined weight fits the budget.
 */
export function fitsInFlight(inFlight: BlockLaneItem[], item: BlockLaneItem, budget = BLOCK_LANE_WEIGHT_BUDGET): boolean {
  if (inFlight.length === 0) return item.weight <= budget;
  if (!item.sharesBlock || inFlight.some((x) => !x.sharesBlock)) return false;
  return inFlight.reduce((s, x) => s + x.weight, 0) + item.weight <= budget;
}
