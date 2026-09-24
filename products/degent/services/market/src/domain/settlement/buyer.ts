/**
 * Buyer side of settlement: assemble the real purchase transaction around the seller's
 * SINGLE|ANYONECANPAY signature, and the padding ("dummy") round.
 *
 * The buyer signs THIS transaction; there is no dummy-input trick. The wallet correctly shows an
 * inscription-bearing input being spent: that is the seller's Degent moving to the buyer in output #1.
 * Hiding it from the wallet is how the legacy engine obtained signatures on a transaction that handed
 * the inscription back to the seller.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { Network } from '@bsh/inscription';
import {
  DUMMY_COUNT,
  INSCRIPTION_INPUT_INDEX,
  MAX_PAYMENT_INPUTS,
  MIN_DUMMY_VALUE,
  PRICE_OUTPUT_INDEX,
  dustFor,
  estimateVsize,
  feeForVsize,
  royaltyFor,
  type BuySummary,
  type DummySummary,
  type ScriptType,
  type TxInputView,
  type TxOutputView,
} from '@bsh/degent-market-sdk';
import { SettlementError } from '../errors.js';
import { STRICT_TX, decodeAddress, encodePsbt, outpointKey, paymentForOwner, type Owner } from './addresses.js';
import { assertTxInscriptionToBuyer, type GuardResult } from './fifo.js';
import type { SellerSignature, Utxo } from './seller.js';
import { sellerWitness, verifyInputSignature } from './verify.js';

export interface ListingForBuy {
  inscriptionId?: string;
  inscriptionUtxo: Utxo;
  /** Offset of the inscribed sat inside the UTXO. */
  satOffset: number;
  sellerAddress: string;
  priceSats: bigint | number;
  sellerSignature: SellerSignature;
}

export interface BuildBuyerArgs {
  listing: ListingForBuy;
  buyerAddress: string;
  buyerPublicKey: string;
  /** Exactly two, each ≥ MIN_DUMMY_VALUE. */
  dummyUtxos: Utxo[];
  /** Candidates; the builder selects largest-first. */
  paymentUtxos: Utxo[];
  feeRate: number;
  royaltyBps?: number;
  treasuryAddress?: string | null;
  network: Network;
}

export interface BuiltBuy {
  psbtHex: string;
  psbtBase64: string;
  buyerInputIndexes: number[];
  destination: GuardResult;
  summary: BuySummary;
  /** Every input's outpoint → value, for the pre-broadcast guard on the raw bytes. */
  prevouts: Array<[string, string]>;
}

const big = (v: bigint | number) => BigInt(v);

function buyerInput(u: Utxo, buyer: Owner) {
  return {
    txid: u.txid,
    index: u.vout,
    sequence: 0xffffffff,
    witnessUtxo: { amount: big(u.value), script: buyer.script },
    ...(buyer.tapInternalKey ? { tapInternalKey: buyer.tapInternalKey } : {}),
  };
}

export function buildBuyerPsbt(a: BuildBuyerArgs): BuiltBuy {
  if (!Number.isFinite(a.feeRate) || a.feeRate < 1) throw new SettlementError('validation_failed', 'feeRate must be ≥ 1 sat/vB');
  if (!Array.isArray(a.dummyUtxos) || a.dummyUtxos.length !== DUMMY_COUNT) throw new SettlementError('need_dummies', `exactly ${DUMMY_COUNT} padding UTXOs are required`);
  for (const d of a.dummyUtxos) if (big(d.value) < BigInt(MIN_DUMMY_VALUE)) throw new SettlementError('need_dummies', `padding UTXOs must be ≥ ${MIN_DUMMY_VALUE} sats`);

  const buyer = paymentForOwner(a.buyerAddress, a.buyerPublicKey, a.network);
  const seller = decodeAddress(a.listing.sellerAddress, a.network);
  const price = big(a.listing.priceSats);
  const postage = big(a.listing.inscriptionUtxo.value);
  const royalty = royaltyFor(price, a.royaltyBps ?? 0);
  let treasury: ReturnType<typeof decodeAddress> | null = null;
  if (royalty > 0n) {
    if (!a.treasuryAddress) throw new SettlementError('validation_failed', 'a treasury address is required when the royalty is > 0');
    treasury = decodeAddress(a.treasuryAddress, a.network);
    if (royalty < dustFor(treasury.type)) throw new SettlementError('validation_failed', `royalty ${royalty} sats is below dust for the treasury address`);
  }
  const dummyTotal = a.dummyUtxos.reduce((s, d) => s + big(d.value), 0n);
  const exclude = new Set([...a.dummyUtxos.map(outpointKey), outpointKey(a.listing.inscriptionUtxo)]);

  // Coin selection over payment candidates, largest first, at most MAX_PAYMENT_INPUTS.
  const candidates = a.paymentUtxos.filter((u) => !exclude.has(outpointKey(u))).sort((x, y) => (big(y.value) > big(x.value) ? 1 : big(y.value) < big(x.value) ? -1 : 0));
  const fixedIn: ScriptType[] = [buyer.type, buyer.type, seller.type];
  const fixedOut: ScriptType[] = [buyer.type, buyer.type, seller.type, ...(treasury ? [treasury.type] : [])];
  const changeDust = dustFor(buyer.type);
  const selected: Utxo[] = [];
  let have = 0n;
  let plan: { fee: bigint; vsize: number; change: bigint } | null = null;
  for (const u of candidates) {
    if (selected.length >= MAX_PAYMENT_INPUTS) break;
    selected.push(u);
    have += big(u.value);
    const inTypes = [...fixedIn, ...selected.map(() => buyer.type)];
    const vWith = estimateVsize(inTypes, [...fixedOut, buyer.type]);
    const feeWith = feeForVsize(vWith, a.feeRate);
    const needWith = price + royalty + feeWith;
    if (have >= needWith + changeDust) {
      plan = { fee: feeWith, vsize: vWith, change: have - needWith };
      break;
    }
    const vNo = estimateVsize(inTypes, fixedOut);
    const feeNo = feeForVsize(vNo, a.feeRate);
    if (have >= price + royalty + feeNo) {
      // What is left is below dust: it goes to the miner instead of creating a dust output.
      plan = { fee: have - price - royalty, vsize: vNo, change: 0n };
      break;
    }
  }
  if (!plan) {
    const avail = candidates.reduce((s, u) => s + big(u.value), 0n);
    throw new SettlementError('insufficient_funds', `insufficient funds: need about ${price + royalty} sats plus fees, spendable ${avail} sats`, {
      needSats: Number(price + royalty),
      spendableSats: Number(avail),
    });
  }

  const tx = new btc.Transaction(STRICT_TX);
  tx.addInput(buyerInput(a.dummyUtxos[0]!, buyer));
  tx.addInput(buyerInput(a.dummyUtxos[1]!, buyer));
  tx.addInput({ txid: a.listing.inscriptionUtxo.txid, index: a.listing.inscriptionUtxo.vout, sequence: 0xffffffff, witnessUtxo: { amount: postage, script: seller.script } });
  for (const u of selected) tx.addInput(buyerInput(u, buyer));
  tx.addOutput({ script: buyer.script, amount: dummyTotal }); // 0 padding merge → buyer
  tx.addOutput({ script: buyer.script, amount: postage }); // 1 inscription → buyer
  tx.addOutput({ script: seller.script, amount: price }); // 2 price → seller (signed)
  if (treasury) tx.addOutput({ script: treasury.script, amount: royalty }); // 3 royalty → treasury
  if (plan.change > 0n) tx.addOutput({ script: buyer.script, amount: plan.change }); // change → buyer
  tx.updateInput(INSCRIPTION_INPUT_INDEX, { finalScriptWitness: sellerWitness(a.listing.sellerSignature) }, true);

  // Invariants: seller signature valid on THIS transaction; inscription → output 1 (buyer); price intact.
  if (!verifyInputSignature(tx, INSCRIPTION_INPUT_INDEX, a.listing.sellerSignature))
    throw new SettlementError('bad_seller_signature', 'the seller signature does not verify against the assembled transaction');
  const destination = assertTxInscriptionToBuyer(tx, {
    satOffset: a.listing.satOffset,
    buyerScript: buyer.script,
    postage,
    ...(a.listing.inscriptionId ? { inscriptionId: a.listing.inscriptionId } : {}),
  });
  const priceOut = tx.getOutput(PRICE_OUTPUT_INDEX);
  if (!priceOut.script || hex.encode(priceOut.script) !== hex.encode(seller.script) || priceOut.amount !== price)
    throw new SettlementError('bad_psbt', 'price output mismatch');
  if (tx.fee !== plan.fee) throw new SettlementError('internal', `fee mismatch ${tx.fee} vs planned ${plan.fee}`);

  const buyerInputIndexes = [0, 1, ...selected.map((_, i) => INSCRIPTION_INPUT_INDEX + 1 + i)];
  const inputs: TxInputView[] = [
    ...a.dummyUtxos.map((u, i) => ({ index: i, outpoint: outpointKey(u), value: Number(u.value), address: a.buyerAddress, owner: 'buyer' as const, role: 'dummy' as const, buyerSigns: true })),
    { index: 2, outpoint: outpointKey(a.listing.inscriptionUtxo), value: Number(postage), address: a.listing.sellerAddress, owner: 'seller', role: 'inscription', buyerSigns: false },
    ...selected.map((u, i) => ({ index: 3 + i, outpoint: outpointKey(u), value: Number(u.value), address: a.buyerAddress, owner: 'buyer' as const, role: 'payment' as const, buyerSigns: true })),
  ];
  const outputs: TxOutputView[] = [
    { index: 0, value: Number(dummyTotal), address: a.buyerAddress, owner: 'buyer', role: 'dummy_merge' },
    { index: 1, value: Number(postage), address: a.buyerAddress, owner: 'buyer', role: 'inscription' },
    { index: 2, value: Number(price), address: a.listing.sellerAddress, owner: 'seller', role: 'price' },
  ];
  if (treasury) outputs.push({ index: 3, value: Number(royalty), address: treasury.address, owner: 'treasury', role: 'royalty' });
  if (plan.change > 0n) outputs.push({ index: outputs.length, value: Number(plan.change), address: a.buyerAddress, owner: 'buyer', role: 'change' });
  const prevouts: Array<[string, string]> = inputs.map((i) => [i.outpoint, String(i.value)]);

  return {
    ...encodePsbt(tx),
    buyerInputIndexes,
    destination,
    prevouts,
    summary: {
      priceSats: Number(price),
      royaltySats: Number(royalty),
      feeSats: Number(plan.fee),
      feeRate: a.feeRate,
      vsize: plan.vsize,
      changeSats: Number(plan.change),
      postageSats: Number(postage),
      totalBuyerCostSats: Number(price + royalty + plan.fee),
      inputs,
      outputs,
    },
  };
}

export interface BuildDummyArgs {
  buyerAddress: string;
  buyerPublicKey: string;
  paymentUtxos: Utxo[];
  feeRate: number;
  count?: number;
  dummyValue?: number;
  network: Network;
}

export interface BuiltDummies {
  psbtHex: string;
  psbtBase64: string;
  buyerInputIndexes: number[];
  summary: DummySummary;
  prevouts: Array<[string, string]>;
}

/** When the buyer has no two small UTXOs, create them: N × dummyValue → buyer, change → buyer. */
export function buildDummySplitPsbt(a: BuildDummyArgs): BuiltDummies {
  if (!Number.isFinite(a.feeRate) || a.feeRate < 1) throw new SettlementError('validation_failed', 'feeRate must be ≥ 1 sat/vB');
  const count = a.count ?? DUMMY_COUNT;
  const buyer = paymentForOwner(a.buyerAddress, a.buyerPublicKey, a.network);
  const dv = BigInt(a.dummyValue ?? MIN_DUMMY_VALUE);
  const candidates = [...a.paymentUtxos].sort((x, y) => (big(y.value) > big(x.value) ? 1 : big(y.value) < big(x.value) ? -1 : 0));
  const changeDust = dustFor(buyer.type);
  const selected: Utxo[] = [];
  let have = 0n;
  let plan: { fee: bigint; change: bigint } | null = null;
  for (const u of candidates) {
    if (selected.length >= MAX_PAYMENT_INPUTS) break;
    selected.push(u);
    have += big(u.value);
    const fee = feeForVsize(estimateVsize(selected.map(() => buyer.type), Array.from({ length: count + 1 }, () => buyer.type)), a.feeRate);
    const need = dv * BigInt(count) + fee;
    if (have >= need + changeDust) {
      plan = { fee, change: have - need };
      break;
    }
  }
  if (!plan) throw new SettlementError('insufficient_funds', 'insufficient funds to create the padding UTXOs');

  const tx = new btc.Transaction(STRICT_TX);
  for (const u of selected) tx.addInput(buyerInput(u, buyer));
  for (let i = 0; i < count; i++) tx.addOutput({ script: buyer.script, amount: dv });
  tx.addOutput({ script: buyer.script, amount: plan.change });
  const inputs: TxInputView[] = selected.map((u, i) => ({ index: i, outpoint: outpointKey(u), value: Number(u.value), address: a.buyerAddress, owner: 'buyer', role: 'payment', buyerSigns: true }));
  const outputs: TxOutputView[] = [
    ...Array.from({ length: count }, (_, i) => ({ index: i, value: Number(dv), address: a.buyerAddress, owner: 'buyer' as const, role: 'dummy' as const })),
    { index: count, value: Number(plan.change), address: a.buyerAddress, owner: 'buyer', role: 'change' },
  ];
  return {
    ...encodePsbt(tx),
    buyerInputIndexes: selected.map((_, i) => i),
    prevouts: inputs.map((i) => [i.outpoint, String(i.value)]),
    summary: { feeSats: Number(plan.fee), feeRate: a.feeRate, changeSats: Number(plan.change), dummyCount: count, dummyValueSats: Number(dv), inputs, outputs },
  };
}
