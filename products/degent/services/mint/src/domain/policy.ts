/**
 * Parent co-signing policy (ADR-0002 §3), as a pure function over the PSBT the worker wants
 * signed. The PolicySigner adapter runs this BEFORE touching the parent key; any violation
 * refuses the signature. The shape is exact: inputs are [parent UTXO, this order's commit
 * outpoint] and outputs are [parent return == parentValue, child == order recipient & postage];
 * nothing else is accepted.
 *
 * One deliberate tightening versus the ADR text ("value >= its input value"): the parent return
 * must carry EXACTLY the parent input value. ord places the child on the first sat of the commit
 * input, i.e. at offset parentValue; a larger output 0 would swallow the child into the
 * collection address. @bsh/inscription.signParentInput enforces the same equality.
 */
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import type { Lane } from '@bsh/degent-mint-sdk';

export interface FeeBand {
  minFeeRate: number;
  maxFeeRate: number;
}

export interface PolicyContext {
  lane: Lane;
  parentOutpoint: { txid: string; vout: number };
  parentValue: bigint;
  parentScript: Uint8Array;
  collectionScript: Uint8Array;
  commitOutpoint: { txid: string; vout: number };
  commitValue: bigint;
  /** P2TR script of this order's commit output (recomputed from K_e pub + content + parent). */
  commitScript: Uint8Array;
  recipientScript: Uint8Array;
  postage: bigint;
  quotedFeeRate: number;
  /** Exact weight of the final signed reveal (from the order's quote). */
  expectedWeight: number;
}

export interface PolicyConfig {
  bands: Record<Lane, FeeBand>;
  /** Max relative deviation of the effective fee rate from the quoted one (vsize rounding). */
  feeRateTolerance: number;
  maxWeight: Record<Lane, number>;
}

export const DUST_P2TR = 330n;

export const DEFAULT_POLICY: PolicyConfig = Object.freeze({
  bands: {
    standard: { minFeeRate: 1, maxFeeRate: 2_000 },
    block: { minFeeRate: 1, maxFeeRate: 500 },
  },
  feeRateTolerance: 0.02,
  maxWeight: { standard: 400_000, block: 3_990_000 },
});

const eq = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** Returns the list of violations; empty means the transaction may be signed. */
export function evaluateParentPolicy(psbtBase64: string, ctx: PolicyContext, cfg: PolicyConfig = DEFAULT_POLICY): string[] {
  const v: string[] = [];
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(base64.decode(psbtBase64), { allowUnknownInputs: true });
  } catch (e) {
    return [`unparseable PSBT: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (tx.inputsLength !== 2) v.push(`expected exactly 2 inputs, got ${tx.inputsLength}`);
  if (tx.outputsLength !== 2) v.push(`expected exactly 2 outputs, got ${tx.outputsLength}`);
  if (v.length) return v;

  const in0 = tx.getInput(0);
  const in1 = tx.getInput(1);
  const out0 = tx.getOutput(0);
  const out1 = tx.getOutput(1);
  const txidOf = (t: Uint8Array | undefined) => (t ? hex.encode(t) : '');

  // input 0: the one parent UTXO
  if (txidOf(in0.txid) !== ctx.parentOutpoint.txid.toLowerCase() || in0.index !== ctx.parentOutpoint.vout)
    v.push('input 0 is not the leased parent UTXO');
  if (in0.witnessUtxo?.amount !== ctx.parentValue) v.push('input 0 value differs from the parent UTXO value');
  if (!eq(in0.witnessUtxo?.script, ctx.parentScript)) v.push('input 0 script differs from the parent UTXO script');

  // input 1: this order's commit output, already signed by the user (0x83)
  if (txidOf(in1.txid) !== ctx.commitOutpoint.txid.toLowerCase() || in1.index !== ctx.commitOutpoint.vout)
    v.push("input 1 is not this order's commit output");
  if (in1.witnessUtxo?.amount !== ctx.commitValue) v.push('input 1 value differs from the order commit value');
  if (!eq(in1.witnessUtxo?.script, ctx.commitScript)) v.push("input 1 script is not this order's commit script");
  if (!in1.tapScriptSig || in1.tapScriptSig.length !== 1) v.push('input 1 is not signed by the reveal key');

  // output 0: parent back to the collection address, same value
  if (!eq(out0.script, ctx.collectionScript)) v.push('output 0 does not return the parent to the collection address');
  if (out0.amount !== ctx.parentValue) v.push('output 0 value must equal the parent input value');

  // output 1: child to the recipient recorded on the order
  if (!eq(out1.script, ctx.recipientScript)) v.push('output 1 does not pay the order recipient');
  if ((out1.amount ?? 0n) < DUST_P2TR) v.push(`output 1 postage below ${DUST_P2TR} sats`);
  if (out1.amount !== ctx.postage) v.push('output 1 postage differs from the order postage');

  // fee rate band of the lane
  if (ctx.expectedWeight > cfg.maxWeight[ctx.lane]) v.push(`weight ${ctx.expectedWeight} exceeds the ${ctx.lane} lane limit`);
  const inSum = (in0.witnessUtxo?.amount ?? 0n) + (in1.witnessUtxo?.amount ?? 0n);
  const outSum = (out0.amount ?? 0n) + (out1.amount ?? 0n);
  const fee = inSum - outSum;
  const vsize = Math.ceil(ctx.expectedWeight / 4);
  const rate = Number(fee) / vsize;
  const band = cfg.bands[ctx.lane];
  if (fee <= 0n) v.push('non-positive fee');
  else {
    if (rate < band.minFeeRate || rate > band.maxFeeRate)
      v.push(`fee rate ${rate.toFixed(3)} sat/vB outside the ${ctx.lane} band ${band.minFeeRate}-${band.maxFeeRate}`);
    if (Math.abs(rate - ctx.quotedFeeRate) / ctx.quotedFeeRate > cfg.feeRateTolerance)
      v.push(`fee rate ${rate.toFixed(3)} sat/vB deviates from the quoted ${ctx.quotedFeeRate} sat/vB`);
  }
  return v;
}
