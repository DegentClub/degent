// Virtual-size estimation and fee-preset selection.
//
// Sizes (vbytes) for the script types this marketplace accepts. Values follow
// the usual segwit accounting (witness bytes count 1/4). Inputs assume a
// key-path spend with a 65-byte Schnorr signature (sighash byte present) for
// taproot and a 72-byte DER signature for P2WPKH, i.e. the worst case.
export const INPUT_VBYTES = Object.freeze({
  tr: 57.75,   // 41 base + 67 witness / 4 (incl. 65-byte sig)
  wpkh: 68,    // 41 base + 108 witness / 4
  pkh: 148,
  sh: 91,      // p2sh-p2wpkh
});

export const OUTPUT_VBYTES = Object.freeze({
  tr: 43,
  wpkh: 31,
  wsh: 43,
  pkh: 34,
  sh: 32,
});

const TX_OVERHEAD_VBYTES = 10.5; // version + locktime + counts + segwit marker/flag

/**
 * @param {{type:string}[]} inputs
 * @param {{type:string}[]} outputs
 * @returns {number} integer vbytes (rounded up)
 */
export function estimateVsize(inputs, outputs) {
  let v = TX_OVERHEAD_VBYTES;
  for (const i of inputs) {
    const s = INPUT_VBYTES[i.type];
    if (!s) throw new Error(`No size estimate for input type ${i.type}`);
    v += s;
  }
  for (const o of outputs) {
    const s = OUTPUT_VBYTES[o.type];
    if (!s) throw new Error(`No size estimate for output type ${o.type}`);
    v += s;
  }
  return Math.ceil(v);
}

export function feeForVsize(vsize, feeRate) {
  return BigInt(Math.ceil(vsize * feeRate));
}

/**
 * Map mempool.space `/api/v1/fees/recommended` to the three tiers offered in
 * the UI. Always at least 1 sat/vB and never below the network minimum.
 */
export function presetsFromMempool(rec) {
  const min = Math.max(1, Number(rec?.minimumFee) || 1);
  const pick = (v, fallback) => Math.max(min, Number(v) || fallback);
  return {
    economy: pick(rec?.economyFee, 2),
    normal: pick(rec?.halfHourFee, 5),
    fast: pick(rec?.fastestFee, 10),
    minimum: min,
  };
}

export function royaltyFor(priceSats, royaltyBps) {
  const price = BigInt(priceSats);
  const bps = BigInt(royaltyBps || 0);
  if (bps === 0n) return 0n;
  // floor(price * bps / 10000)
  return (price * bps) / 10_000n;
}
