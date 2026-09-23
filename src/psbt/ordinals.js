// Ordinal theory, first-in-first-out.
//
// Sats are numbered. A transaction's inputs are concatenated into one long
// range of sats, and outputs are filled from that range in order. An inscription
// is bound to a single sat, so the sat's absolute position across the inputs
// decides which output it lands in. Fees are taken from the END of the range.
//
// This calculator is the single source of truth the builder asserts against.
// The pre-rewrite engine put the inscription in input 0 and the seller's payout
// in output 0 — so the inscription sat (offset 0 of input 0) landed in output 0,
// i.e. it was handed straight back to the seller while the buyer paid. See
// docs/SETTLEMENT.md.

/**
 * @param {{value:number|bigint}[]} inputs   ordered inputs (amounts)
 * @param {{value:number|bigint}[]} outputs  ordered outputs (amounts)
 * @param {number} inscriptionInputIndex     which input carries the inscription
 * @param {number|bigint} inscriptionOffset  offset of the inscribed sat inside that input
 * @returns {{outputIndex:number, offsetInOutput:bigint, absolute:bigint, paidAsFee:boolean}}
 */
export function computeOrdinalDestination(inputs, outputs, inscriptionInputIndex, inscriptionOffset = 0) {
  if (!Number.isInteger(inscriptionInputIndex) || inscriptionInputIndex < 0 || inscriptionInputIndex >= inputs.length) {
    throw new RangeError(`inscriptionInputIndex ${inscriptionInputIndex} out of range`);
  }
  const off = BigInt(inscriptionOffset);
  const inVal = BigInt(inputs[inscriptionInputIndex].value);
  if (off < 0n || off >= inVal) {
    throw new RangeError(`inscription offset ${off} is outside input value ${inVal}`);
  }
  let absolute = 0n;
  for (let i = 0; i < inscriptionInputIndex; i++) absolute += BigInt(inputs[i].value);
  absolute += off;

  let cursor = 0n;
  for (let i = 0; i < outputs.length; i++) {
    const v = BigInt(outputs[i].value);
    if (absolute < cursor + v) {
      return { outputIndex: i, offsetInOutput: absolute - cursor, absolute, paidAsFee: false };
    }
    cursor += v;
  }
  // Beyond the last output: the sat was consumed as fee (burned to the miner).
  return { outputIndex: -1, offsetInOutput: absolute - cursor, absolute, paidAsFee: true };
}

/** Convenience: sum of a value list as bigint. */
export function sumValues(items) {
  return items.reduce((acc, i) => acc + BigInt(i.value), 0n);
}
