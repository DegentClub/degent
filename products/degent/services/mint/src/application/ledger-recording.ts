/**
 * What the mint tells the platform ledger about an artwork order (plan §3.5, ADR-0009). Pure: builds the
 * line items from the order's binding quote; the OrderService does the calls.
 *
 * The ledger's `psbt` payment method requires a payee on EVERY line item and the payee outputs to sum to the
 * order total (it derives the expected outputs of the funding transaction from them and settles the intent
 * when a transaction carries all of them), so the network-cost line names the commit output as the
 * `platform` payee `commit` (the platform's own convention, see @bsh/ledger's psbt tests and the scribb.it
 * MCP order tools) rather than "no payee" as the plan first said. The three expected outputs are then
 * exactly the funding layout of plan §3.2: commit, artist royalty, club fee.
 */
import { TIER_LABELS } from '@bsh/degent-mint-sdk';
import type { OrderRecord } from '../domain/order.js';
import type { LedgerLineItem } from '../ports/ledger-client.js';
import type { MintSettings } from './settings.js';

export const LEDGER_SKUS = Object.freeze({ networkCost: 'network-cost', clubFee: 'club-fee', artistRoyalty: 'artist-royalty' });
export const CLUB_PAYEE_REF = 'degent-club';
export const COMMIT_PAYEE_REF = 'commit';

export function buildLedgerLineItems(r: OrderRecord, s: MintSettings): LedgerLineItem[] {
  const q = r.quote;
  if (!q || !q.commitAddress) throw new Error('ledger line items need a binding quote');
  const items: LedgerLineItem[] = [
    {
      sku: LEDGER_SKUS.networkCost,
      description: `${TIER_LABELS[r.tier]} reveal: network cost (reveal fee + postage), the commit output`,
      quantity: 1,
      unitSats: q.commitValueSats,
      payee: { kind: 'platform', ref: COMMIT_PAYEE_REF, address: q.commitAddress },
    },
  ];
  const clubFee = q.clubFeeSats ?? 0;
  if (clubFee > 0) {
    if (!s.serviceFeeAddress) throw new Error('club fee without SERVICE_FEE_ADDRESS');
    items.push({ sku: LEDGER_SKUS.clubFee, description: 'Degent Club fee', quantity: 1, unitSats: clubFee, payee: { kind: 'club', ref: CLUB_PAYEE_REF, address: s.serviceFeeAddress } });
  }
  const royalty = q.artistRoyaltySats ?? 0;
  if (royalty > 0) {
    if (!r.artistAddress) throw new Error('artist royalty without an artist address');
    items.push({
      sku: LEDGER_SKUS.artistRoyalty,
      description: `Artist royalty for artwork ${r.artworkId}`,
      quantity: 1,
      unitSats: royalty,
      payee: { kind: 'artist', ref: r.artistAddress, address: r.artistAddress },
    });
  }
  return items;
}

/** Idempotency keys: worker retries never create a second ledger order or intent for a mint order. */
export const ledgerIdempotencyKeys = (orderId: string) => ({ order: `degent-mint:${orderId}:order`, payment: `degent-mint:${orderId}:payment` });
