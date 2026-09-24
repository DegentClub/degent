/**
 * Buyer side. Builds the purchase transaction the seller's 0x83 signature was made for, with the
 * buyer's PADDING ("dummy") INPUTS AND OUTPUTS BEFORE THE INSCRIPTION INPUT:
 *
 *   inputs   [0] buyer padding A        outputs  [0] padding merge   = A + B   (back to the buyer)
 *            [1] buyer padding B                 [1] buyer receives  = inscription UTXO value
 *            [2] seller's inscription (0x83)     [2] seller payment  = price      <- signed by the seller
 *            [3..] buyer payment(s)              [3] buyer change (optional)
 *                                                [4..] new padding outputs (optional, for the next purchase)
 *
 * Ordinal FIFO: output 0 consumes exactly the A + B sats, so the inscription input's first sat is
 * the first sat of output 1, the buyer's. The fee is the tail of the input sats, i.e. the buyer's
 * payment coins, never the inscription sat.
 *
 * The audited bug: a layout with the inscription FIRST ([inscription, payment] -> [seller payment,
 * buyer receive, ...]) sends the inscribed sat into output 0, the SELLER'S payment. The seller is
 * paid AND keeps the inscription. `test/ordinals.test.ts` reproduces it with the simulator.
 *
 * Output: a PSBT for the buyer's wallet. Input 2 already carries the seller's key-path signature
 * (`tapKeySig`, hash type 0x83); every buyer input carries `sighashType` SIGHASH_DEFAULT, honest
 * witnessUtxo data and, for P2TR, `tapInternalKey`, so wallets can show exactly what they sign.
 * Nothing is done to suppress wallet warnings: a wallet that warns about an input it does not own
 * (input 2), or about the seller's non-default sighash, is right to, and the buyer should read it.
 * `finalizePurchase` turns the wallet-signed PSBT into the raw transaction and re-checks that the
 * seller's signature is still the one from the listing.
 */
import { hex, base64 } from '@scure/base';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import { networkParams, type Network } from './network.js';
import { inscriptionUtxoOf, LAYOUT, PLACEHOLDER_SEQUENCE, TX_VERSION, verifyListing, type Listing } from './listing.js';
import { inscriptionDestination, type SatDestination } from './ordinals.js';

export const DUST_P2TR = 330n;
export const DUST_P2WPKH = 294n;
/** Value of the padding outputs this library creates for the buyer's next purchase. */
export const DEFAULT_PADDING_VALUE = 600n;

export interface BuyerUtxo {
  txid: string;
  vout: number;
  value: bigint;
  /** scriptPubKey: P2TR (0x5120..) or P2WPKH (0x0014..). */
  script: Uint8Array;
  /** P2TR key path: the x-only internal key (needed by wallets to sign). */
  tapInternalKey?: Uint8Array;
}

export type InputKind = 'p2tr' | 'p2wpkh';

export function inputKind(script: Uint8Array): InputKind {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr';
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh';
  throw new Error('buyer UTXOs must be P2TR or P2WPKH');
}

/** Witness weight (WU) of a signed input, upper bound for ECDSA (72-byte DER + hash type). */
export function witnessWeight(kind: InputKind, sighashDefault = true): number {
  // items count (1) + [len(1) + sig] (+ [len(1) + pubkey 33] for p2wpkh)
  if (kind === 'p2tr') return 1 + 1 + (sighashDefault ? 64 : 65);
  return 1 + 1 + 72 + 1 + 33;
}

export interface PurchaseWeightArgs {
  inputs: Array<{ kind: InputKind; sighashDefault?: boolean }>;
  /** scriptPubKey lengths of every output, in order. */
  outputScriptLengths: number[];
}

/** Weight of the fully signed purchase tx; exact for P2TR inputs, an upper bound for P2WPKH (DER length). */
export function estimatePurchaseWeight(a: PurchaseWeightArgs): number {
  const varint = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
  let base = 4 + varint(a.inputs.length) + a.inputs.length * 41 + varint(a.outputScriptLengths.length) + 4;
  for (const len of a.outputScriptLengths) base += 8 + varint(len) + len;
  let witness = 2;
  for (const i of a.inputs) witness += witnessWeight(i.kind, i.sighashDefault ?? true);
  return base * 4 + witness;
}

export const vsizeFromWeight = (w: number): number => Math.ceil(w / 4);

export interface PurchaseArgs {
  network: Network;
  listing: Listing;
  buyer: {
    /** Padding inputs: small, inscription-free coins. At least one; LAYOUT.paddingInputs (2) is the standard. */
    padding: BuyerUtxo[];
    /** Payment coins, selected greedily in order until price + fee (+ new padding) is covered. */
    payments: BuyerUtxo[];
    /** Ordinals (P2TR) address that receives the inscription. */
    receiveAddress: string;
    changeAddress: string;
  };
  /** sat/vB. */
  feeRate: number;
  /** Append this many padding outputs (DEFAULT_PADDING_VALUE each) after change, for the next purchase. */
  newPaddingOutputs?: number;
  paddingValue?: bigint;
}

export interface PurchaseOutput {
  index: number;
  label: 'padding-merge' | 'buyer-receive' | 'seller-payment' | 'change' | 'new-padding';
  address: string;
  value: bigint;
}

export interface Purchase {
  psbtBase64: string;
  /** Indexes of the inputs the buyer's wallet must sign (every input except the seller's). */
  inputsToSign: number[];
  outputs: PurchaseOutput[];
  fee: bigint;
  /** Weight/vsize the fee was computed for (exact for P2TR buyer inputs, upper bound for P2WPKH). */
  weight: number;
  vsize: number;
  /** Where ordinal FIFO puts the inscribed sat in this transaction: always output 1 for this layout. */
  inscriptionLandsIn: SatDestination;
}

export class InsufficientFundsError extends Error {
  constructor(readonly needed: bigint, readonly available: bigint) {
    super(`insufficient funds: need ${needed} sats, have ${available}`);
    this.name = 'InsufficientFundsError';
  }
}

export function buildPurchase(args: PurchaseArgs): Purchase {
  const { listing, buyer } = args;
  if (listing.network !== args.network) throw new Error(`network mismatch: listing is for ${listing.network}, building for ${args.network}`);
  const v = verifyListing(listing);
  if (!v.ok) throw new Error(`invalid listing: ${v.reason}`);
  if (listing.layout.inscriptionInputIndex !== LAYOUT.inscriptionInputIndex || listing.layout.sellerPaymentOutputIndex !== LAYOUT.sellerPaymentOutputIndex)
    throw new Error('listing layout is not the one this library builds');
  if (buyer.padding.length < 1) throw new Error('at least one padding input is required');
  if (buyer.padding.length !== LAYOUT.paddingInputs) throw new Error(`this layout takes exactly ${LAYOUT.paddingInputs} padding inputs`);
  if (!Number.isFinite(args.feeRate) || args.feeRate <= 0) throw new RangeError('feeRate must be positive');
  const net = networkParams(args.network);
  const utxo = inscriptionUtxoOf(listing);
  const price = BigInt(listing.priceSats);
  const receiveScript = OutScript.encode(Address(net).decode(buyer.receiveAddress));
  const changeScript = OutScript.encode(Address(net).decode(buyer.changeAddress));
  const sellerScript = OutScript.encode(Address(net).decode(listing.sellerReceiveAddress));
  if (!(receiveScript.length === 34 && receiveScript[0] === 0x51)) throw new Error('receiveAddress must be a taproot (ordinals) address');
  const paddingValue = args.paddingValue ?? DEFAULT_PADDING_VALUE;
  const newPadding = args.newPaddingOutputs ?? 0;
  if (paddingValue < DUST_P2TR) throw new RangeError('paddingValue below dust');
  for (const p of buyer.padding) if (p.value < DUST_P2TR) throw new RangeError('padding inputs must be at least dust');

  const paddingSum = buyer.padding.reduce((a, p) => a + p.value, 0n);
  const changeDust = changeScript.length === 22 ? DUST_P2WPKH : DUST_P2TR;

  // Greedy payment selection with an exact (P2TR) / upper-bound (P2WPKH) fee at each step.
  const inputsKinds = (payments: BuyerUtxo[]) => [
    ...buyer.padding.map((p) => ({ kind: inputKind(p.script) })),
    { kind: 'p2tr' as const, sighashDefault: false }, // the seller's 0x83 input
    ...payments.map((p) => ({ kind: inputKind(p.script) })),
  ];
  const outputsLens = (withChange: boolean) => [
    changeScript.length /* padding merge, back to the buyer's change/payment address */,
    receiveScript.length,
    sellerScript.length,
    ...(withChange ? [changeScript.length] : []),
    ...Array.from({ length: newPadding }, () => changeScript.length),
  ];
  const feeFor = (payments: BuyerUtxo[], withChange: boolean) =>
    BigInt(Math.ceil(vsizeFromWeight(estimatePurchaseWeight({ inputs: inputsKinds(payments), outputScriptLengths: outputsLens(withChange) })) * args.feeRate));

  const selected: BuyerUtxo[] = [];
  let paid = 0n;
  let fee = 0n;
  let change = 0n;
  let withChange = false;
  const target = () => price + BigInt(newPadding) * paddingValue;
  let funded = false;
  for (const p of buyer.payments) {
    selected.push(p);
    paid += p.value;
    const feeNoChange = feeFor(selected, false);
    const feeChange = feeFor(selected, true);
    const leftover = paid - target() - feeChange;
    if (leftover >= changeDust) {
      withChange = true;
      fee = feeChange;
      change = leftover;
      funded = true;
      break;
    }
    if (paid - target() - feeNoChange >= 0n) {
      withChange = false;
      fee = paid - target(); // sub-dust remainder goes to the miner
      change = 0n;
      funded = true;
      break;
    }
  }
  if (!funded) throw new InsufficientFundsError(target() + feeFor(buyer.payments, true), buyer.payments.reduce((a, p) => a + p.value, 0n));

  const tx = new Transaction({ version: TX_VERSION, lockTime: 0, allowUnknownInputs: true });
  const addBuyerInput = (u: BuyerUtxo) => {
    const kind = inputKind(u.script);
    tx.addInput({
      txid: hex.decode(u.txid),
      index: u.vout,
      sequence: PLACEHOLDER_SEQUENCE,
      witnessUtxo: { script: u.script, amount: u.value },
      sighashType: 0x00, // SIGHASH_DEFAULT: the buyer signs the whole transaction
      ...(kind === 'p2tr' && u.tapInternalKey ? { tapInternalKey: u.tapInternalKey } : {}),
    });
  };
  for (const p of buyer.padding) addBuyerInput(p);
  tx.addInput({
    txid: hex.decode(utxo.txid),
    index: utxo.vout,
    sequence: PLACEHOLDER_SEQUENCE,
    witnessUtxo: { script: utxo.script, amount: utxo.value },
    sighashType: 0x83,
  });
  for (const p of selected) addBuyerInput(p);

  const outputs: PurchaseOutput[] = [];
  const addOutput = (label: PurchaseOutput['label'], script: Uint8Array, value: bigint) => {
    outputs.push({ index: outputs.length, label, address: Address(net).encode(OutScript.decode(script)), value });
    tx.addOutput({ script, amount: value });
  };
  addOutput('padding-merge', changeScript, paddingSum);
  addOutput('buyer-receive', receiveScript, utxo.value);
  addOutput('seller-payment', sellerScript, price);
  if (withChange) addOutput('change', changeScript, change);
  for (let i = 0; i < newPadding; i++) addOutput('new-padding', changeScript, paddingValue);

  // The seller's signature goes in last, once every output exists (the library refuses to add
  // outputs to a transaction that already carries a signature, which is the right instinct). It is
  // stored as the PSBT taproot key-path partial signature (`tapKeySig`, 64 bytes + 0x83), so any
  // PSBT finalizer, including the buyer's wallet, turns it into the witness [sig].
  tx.updateInput(LAYOUT.inscriptionInputIndex, { tapKeySig: hex.decode(listing.sellerSignatureHex) }, true);

  const weight = estimatePurchaseWeight({ inputs: inputsKinds(selected), outputScriptLengths: outputsLens(withChange) });
  const inscriptionLandsIn = inscriptionDestination(
    [
      ...buyer.padding.map((p) => ({ value: p.value })),
      { value: utxo.value, inscriptionOffset: utxo.inscriptionOffset ?? 0 },
      ...selected.map((p) => ({ value: p.value })),
    ],
    outputs.map((o) => ({ value: o.value })),
    fee,
  );
  if (inscriptionLandsIn.kind !== 'output' || inscriptionLandsIn.index !== LAYOUT.buyerReceiveOutputIndex)
    throw new Error('internal: the inscribed sat would not land in the buyer output');

  return {
    psbtBase64: base64.encode(tx.toPSBT()),
    inputsToSign: Array.from({ length: tx.inputsLength }, (_, i) => i).filter((i) => i !== LAYOUT.inscriptionInputIndex),
    outputs,
    fee,
    weight,
    vsize: vsizeFromWeight(weight),
    inscriptionLandsIn,
  };
}

export interface FinalizedPurchase {
  hex: string;
  txid: string;
  weight: number;
  vsize: number;
  fee: bigint;
}

/**
 * Finalize the PSBT the buyer's wallet signed and extract the raw transaction. Refuses a PSBT in
 * which the seller's input no longer carries exactly the listing's signature.
 */
export function finalizePurchase(signedPsbtBase64: string, listing: Listing): FinalizedPurchase {
  const tx = Transaction.fromPSBT(base64.decode(signedPsbtBase64), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const sellerSig = hex.decode(listing.sellerSignatureHex);
  const inp = tx.getInput(LAYOUT.inscriptionInputIndex);
  const carried = inp.finalScriptWitness?.[0] ?? inp.tapKeySig;
  if (!carried || carried.length !== sellerSig.length || !carried.every((b, i) => b === sellerSig[i]))
    throw new Error("the seller's signature on input 2 is not the listing's");
  if (hex.encode(inp.txid!) !== listing.inscription.txid || inp.index !== listing.inscription.vout) throw new Error('input 2 is not the listed inscription');
  const out = tx.getOutput(LAYOUT.sellerPaymentOutputIndex);
  if (out.amount !== BigInt(listing.priceSats)) throw new Error('output 2 does not pay the listed price');
  for (let i = 0; i < tx.inputsLength; i++) tx.finalizeIdx(i);
  const raw = tx.extract();
  const final = Transaction.fromRaw(raw, { allowUnknownInputs: true, allowUnknownOutputs: true });
  return { hex: hex.encode(raw), txid: final.id, weight: final.weight, vsize: final.vsize, fee: tx.fee };
}

/**
 * The LEGACY layout the audit found: inscription input first, seller paid first. Built only so the
 * tests can show, with the same simulator, that it hands the inscribed sat to the seller. Never
 * sign this.
 */
export function legacyLayoutValues(args: { inscriptionValue: bigint; price: bigint; payment: bigint; fee: bigint }) {
  return {
    inputs: [{ value: args.inscriptionValue, inscriptionOffset: 0 }, { value: args.payment }],
    outputs: [{ value: args.price }, { value: args.inscriptionValue }, { value: args.payment - args.price - args.fee }],
    fee: args.fee,
  };
}
