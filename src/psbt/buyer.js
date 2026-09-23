// Buyer side of settlement: assemble the real purchase transaction around the
// seller's SINGLE|ANYONECANPAY signature.
//
// The buyer signs THIS transaction — there is no dummy-input trick. The wallet
// will (correctly) show that an inscription-bearing input is being spent; that
// is exactly what happens, the inscription is moving from the seller to the
// buyer in output #1. Hiding that from the wallet was how the previous engine
// got a signature on a transaction that gave the inscription back to the
// seller.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { paymentForOwner, decodeAddress, dustFor } from './addresses.js';
import { computeOrdinalDestination } from './ordinals.js';
import { estimateVsize, feeForVsize, royaltyFor } from './fees.js';
import { verifyInputSignature } from './verify.js';
import { INSCRIPTION_INPUT_INDEX, PRICE_OUTPUT_INDEX, DUMMY_COUNT } from './seller.js';

export const DUMMY_MERGE_OUTPUT_INDEX = 0;
export const INSCRIPTION_OUTPUT_INDEX = 1;
export const MIN_DUMMY_VALUE = 600n;
export const MAX_PAYMENT_INPUTS = 20;

export class BuildError extends Error {
  constructor(msg, code = 'BUILD_ERROR') { super(msg); this.name = 'BuildError'; this.status = 400; this.code = code; }
}

/**
 * @param {object} p
 * @param {object} p.listing
 * @param {{txid:string, vout:number, value:number|bigint}} p.listing.inscriptionUtxo
 * @param {number} p.listing.satOffset            inscription offset inside the UTXO
 * @param {string} p.listing.sellerAddress
 * @param {number|bigint} p.listing.priceSats
 * @param {{signatureHex:string, kind:'schnorr'|'ecdsa', publicKeyHex?:string}} p.listing.sellerSignature
 * @param {string} p.buyerAddress
 * @param {string} p.buyerPublicKey
 * @param {{txid:string, vout:number, value:number|bigint}[]} p.dummyUtxos   exactly two, ≥600 sats each
 * @param {{txid:string, vout:number, value:number|bigint}[]} p.paymentUtxos  candidates; the builder selects
 * @param {number} p.feeRate                      sat/vB
 * @param {number} [p.royaltyBps]
 * @param {string} [p.treasuryAddress]
 * @param {import('@scure/btc-signer').BTC_NETWORK} p.network
 */
export function buildBuyerPsbt({
  listing, buyerAddress, buyerPublicKey, dummyUtxos, paymentUtxos,
  feeRate, royaltyBps = 0, treasuryAddress = '', network,
}) {
  if (!Number.isFinite(feeRate) || feeRate < 1) throw new BuildError('feeRate must be ≥ 1 sat/vB');
  if (!Array.isArray(dummyUtxos) || dummyUtxos.length !== DUMMY_COUNT) {
    throw new BuildError(`Exactly ${DUMMY_COUNT} dummy UTXOs are required`, 'NEED_DUMMIES');
  }
  for (const d of dummyUtxos) {
    if (BigInt(d.value) < MIN_DUMMY_VALUE) throw new BuildError(`Dummy UTXOs must be ≥ ${MIN_DUMMY_VALUE} sats`, 'NEED_DUMMIES');
  }
  const buyer = paymentForOwner(buyerAddress, buyerPublicKey, network);
  const seller = decodeAddress(listing.sellerAddress, network);
  const price = BigInt(listing.priceSats);
  const postage = BigInt(listing.inscriptionUtxo.value);
  const royalty = royaltyFor(price, royaltyBps);
  let treasury = null;
  if (royalty > 0n) {
    if (!treasuryAddress) throw new BuildError('treasuryAddress required when royaltyBps > 0');
    treasury = decodeAddress(treasuryAddress, network);
    if (royalty < BigInt(dustFor(treasury.type))) {
      throw new BuildError(`Royalty ${royalty} sats is below dust for the treasury address`);
    }
  }
  const dummyTotal = dummyUtxos.reduce((a, d) => a + BigInt(d.value), 0n);
  const outpointKey = (u) => `${u.txid}:${u.vout}`;
  const dummyKeys = new Set(dummyUtxos.map(outpointKey));
  const inscKey = outpointKey(listing.inscriptionUtxo);

  // ── coin selection over payment candidates ──
  const candidates = [...paymentUtxos]
    .filter((u) => !dummyKeys.has(outpointKey(u)) && outpointKey(u) !== inscKey)
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));

  const fixedInputTypes = [{ type: buyer.type }, { type: buyer.type }, { type: seller.type }];
  const fixedOutputTypes = [{ type: buyer.type }, { type: buyer.type }, { type: seller.type }];
  if (treasury) fixedOutputTypes.push({ type: treasury.type });
  const changeDust = BigInt(dustFor(buyer.type));

  const selected = [];
  let have = 0n;
  let plan = null;
  for (const u of candidates) {
    if (selected.length >= MAX_PAYMENT_INPUTS) break;
    selected.push(u);
    have += BigInt(u.value);
    const inTypes = [...fixedInputTypes, ...selected.map(() => ({ type: buyer.type }))];
    const vWithChange = estimateVsize(inTypes, [...fixedOutputTypes, { type: buyer.type }]);
    const feeWithChange = feeForVsize(vWithChange, feeRate);
    const needWithChange = price + royalty + feeWithChange;
    if (have >= needWithChange + changeDust) {
      plan = { fee: feeWithChange, vsize: vWithChange, change: have - needWithChange };
      break;
    }
    const vNoChange = estimateVsize(inTypes, fixedOutputTypes);
    const feeNoChange = feeForVsize(vNoChange, feeRate);
    if (have >= price + royalty + feeNoChange) {
      // Remaining sats below dust — let them go to the miner instead of creating dust.
      plan = { fee: have - price - royalty, vsize: vNoChange, change: 0n };
      break;
    }
  }
  if (!plan) {
    const totalAvail = candidates.reduce((a, u) => a + BigInt(u.value), 0n);
    throw new BuildError(
      `Insufficient funds: need about ${price + royalty} sats plus fees, spendable ${totalAvail} sats`,
      'INSUFFICIENT_FUNDS',
    );
  }

  // ── assemble ──
  const tx = new btc.Transaction({ allowUnknownInputs: false, allowUnknownOutputs: false });
  const buyerInput = (u) => {
    const i = { txid: u.txid, index: u.vout, sequence: 0xffffffff, witnessUtxo: { amount: BigInt(u.value), script: buyer.script } };
    if (buyer.type === 'tr') i.tapInternalKey = buyer.tapInternalKey;
    return i;
  };
  tx.addInput(buyerInput(dummyUtxos[0]));
  tx.addInput(buyerInput(dummyUtxos[1]));
  tx.addInput({
    txid: listing.inscriptionUtxo.txid,
    index: listing.inscriptionUtxo.vout,
    sequence: 0xffffffff,
    witnessUtxo: { amount: postage, script: seller.script },
  });
  for (const u of selected) tx.addInput(buyerInput(u));

  tx.addOutput({ script: buyer.script, amount: dummyTotal });          // 0 dummy merge → buyer
  tx.addOutput({ script: buyer.script, amount: postage });             // 1 inscription → buyer
  tx.addOutput({ script: seller.script, amount: price });              // 2 price → seller (signed)
  if (treasury) tx.addOutput({ script: treasury.script, amount: royalty }); // 3 royalty → treasury
  if (plan.change > 0n) tx.addOutput({ script: buyer.script, amount: plan.change }); // change → buyer

  // Seller's witness goes straight in as a finalized input.
  const sig = listing.sellerSignature;
  const sellerWitness = sig.kind === 'ecdsa'
    ? [hex.decode(sig.signatureHex), hex.decode(sig.publicKeyHex)]
    : [hex.decode(sig.signatureHex)];
  tx.updateInput(INSCRIPTION_INPUT_INDEX, { finalScriptWitness: sellerWitness }, true);

  // ── invariants ──
  if (!verifyInputSignature(tx, INSCRIPTION_INPUT_INDEX, sig)) {
    throw new BuildError('Seller signature does not verify against the assembled transaction', 'BAD_SELLER_SIG');
  }
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) inputs.push({ value: tx.getInput(i).witnessUtxo.amount });
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) outputs.push({ value: tx.getOutput(i).amount });
  const dest = computeOrdinalDestination(inputs, outputs, INSCRIPTION_INPUT_INDEX, listing.satOffset ?? 0);
  if (dest.outputIndex !== INSCRIPTION_OUTPUT_INDEX) {
    throw new BuildError(`Ordinal would land in output ${dest.outputIndex}, expected ${INSCRIPTION_OUTPUT_INDEX}`, 'ORDINAL_MISROUTED');
  }
  if (hex.encode(tx.getOutput(INSCRIPTION_OUTPUT_INDEX).script) !== hex.encode(buyer.script)) {
    throw new BuildError('Inscription output is not owned by the buyer', 'ORDINAL_MISROUTED');
  }
  if (hex.encode(tx.getOutput(PRICE_OUTPUT_INDEX).script) !== hex.encode(seller.script) || tx.getOutput(PRICE_OUTPUT_INDEX).amount !== price) {
    throw new BuildError('Price output mismatch', 'BAD_LAYOUT');
  }
  if (tx.fee !== plan.fee) throw new BuildError(`Fee mismatch ${tx.fee} vs planned ${plan.fee}`);

  const buyerInputIndexes = [0, 1, ...selected.map((_, i) => INSCRIPTION_INPUT_INDEX + 1 + i)];
  return {
    psbtHex: hex.encode(tx.toPSBT()),
    psbtBase64: Buffer.from(tx.toPSBT()).toString('base64'),
    toSignInputs: buyerInputIndexes.map((index) => ({ index, address: buyerAddress })),
    buyerInputIndexes,
    ordinalDestination: { outputIndex: dest.outputIndex, offsetInOutput: dest.offsetInOutput.toString() },
    summary: {
      priceSats: price.toString(),
      royaltySats: royalty.toString(),
      feeSats: plan.fee.toString(),
      feeRate,
      estimatedVsize: plan.vsize,
      changeSats: plan.change.toString(),
      postageSats: postage.toString(),
      dummyMergeSats: dummyTotal.toString(),
      totalBuyerCost: (price + royalty + plan.fee).toString(),
      paymentInputs: selected.map((u) => `${u.txid}:${u.vout}`),
      dummyInputs: dummyUtxos.map((u) => `${u.txid}:${u.vout}`),
      outputs: outputs.map((o, i) => ({ index: i, value: o.value.toString() })),
    },
  };
}

/**
 * When the buyer has no two small UTXOs, create them: N × dummyValue → buyer,
 * change → buyer. Every input is the buyer's, all signed with SIGHASH_DEFAULT/ALL.
 */
export function buildDummySplitPsbt({ buyerAddress, buyerPublicKey, paymentUtxos, feeRate, count = DUMMY_COUNT, dummyValue = MIN_DUMMY_VALUE, network }) {
  const buyer = paymentForOwner(buyerAddress, buyerPublicKey, network);
  const dv = BigInt(dummyValue);
  const candidates = [...paymentUtxos].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
  const changeDust = BigInt(dustFor(buyer.type));
  const selected = [];
  let have = 0n;
  let plan = null;
  for (const u of candidates) {
    selected.push(u);
    have += BigInt(u.value);
    const inTypes = selected.map(() => ({ type: buyer.type }));
    const outTypes = Array.from({ length: count + 1 }, () => ({ type: buyer.type }));
    const fee = feeForVsize(estimateVsize(inTypes, outTypes), feeRate);
    const need = dv * BigInt(count) + fee;
    if (have >= need + changeDust) { plan = { fee, change: have - need }; break; }
  }
  if (!plan) throw new BuildError('Insufficient funds to create dummy UTXOs', 'INSUFFICIENT_FUNDS');

  const tx = new btc.Transaction();
  for (const u of selected) {
    const i = { txid: u.txid, index: u.vout, sequence: 0xffffffff, witnessUtxo: { amount: BigInt(u.value), script: buyer.script } };
    if (buyer.type === 'tr') i.tapInternalKey = buyer.tapInternalKey;
    tx.addInput(i);
  }
  for (let i = 0; i < count; i++) tx.addOutput({ script: buyer.script, amount: dv });
  tx.addOutput({ script: buyer.script, amount: plan.change });
  const buyerInputIndexes = selected.map((_, i) => i);
  return {
    psbtHex: hex.encode(tx.toPSBT()),
    toSignInputs: buyerInputIndexes.map((index) => ({ index, address: buyerAddress })),
    buyerInputIndexes,
    summary: { feeSats: plan.fee.toString(), changeSats: plan.change.toString(), dummyCount: count, dummyValue: dv.toString(), feeRate },
  };
}
