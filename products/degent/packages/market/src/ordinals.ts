/**
 * Ordinal theory, first-in-first-out (the ord reference implementation's assignment rule):
 *
 *   - the sats of a transaction's inputs are concatenated in input order;
 *   - they are assigned to the outputs in output order, each output taking the next `value` sats;
 *   - whatever is left over (the fee) is the TAIL of that sequence, i.e. the last sats of the last
 *     inputs, and goes to the miner.
 *
 * An inscription lives on one sat (`inscriptionOffset` inside its input, 0 for the first sat, which
 * is where an inscription created by a reveal sits). This simulator says where that sat lands. It
 * is the oracle the marketplace tests use to PROVE the purchase layout delivers the inscription to
 * the buyer, and to reproduce the audited bug (inscription input first -> its sat lands in the
 * seller's payment output).
 */

export interface SimInput {
  value: bigint | number;
  /** Offset of the inscribed sat inside this input; omit for inputs that carry no inscription. */
  inscriptionOffset?: number;
}

export interface SimOutput {
  value: bigint | number;
}

export type SatDestination = { kind: 'output'; index: number; offset: bigint } | { kind: 'fee'; offset: bigint };

export interface SimResult {
  /** Destination of every inscribed sat, in input order (one entry per input that has an inscription). */
  placements: Array<{ inputIndex: number; destination: SatDestination }>;
  totalIn: bigint;
  totalOut: bigint;
  fee: bigint;
}

const big = (v: bigint | number): bigint => (typeof v === 'bigint' ? v : BigInt(v));

/**
 * Where does each inscribed sat go? `fee` must equal `sum(inputs) - sum(outputs)` (pass it so the
 * caller states what it believes the fee is; the simulator refuses a contradiction rather than
 * silently reinterpreting the transaction).
 */
export function simulateOrdinalTransfer(inputs: SimInput[], outputs: SimOutput[], fee: bigint | number): SimResult {
  const totalIn = inputs.reduce((a, i) => a + big(i.value), 0n);
  const totalOut = outputs.reduce((a, o) => a + big(o.value), 0n);
  const f = big(fee);
  if (totalIn - totalOut !== f) throw new RangeError(`fee ${f} != inputs ${totalIn} - outputs ${totalOut}`);
  if (f < 0n) throw new RangeError('outputs exceed inputs');
  const placements: SimResult['placements'] = [];
  let inputStart = 0n;
  inputs.forEach((inp, inputIndex) => {
    const value = big(inp.value);
    if (inp.inscriptionOffset !== undefined) {
      const off = BigInt(inp.inscriptionOffset);
      if (off < 0n || off >= value) throw new RangeError(`inscription offset ${off} outside input ${inputIndex} (${value} sats)`);
      const global = inputStart + off;
      let outputStart = 0n;
      let destination: SatDestination | null = null;
      for (let index = 0; index < outputs.length; index++) {
        const v = big(outputs[index]!.value);
        if (global >= outputStart && global < outputStart + v) {
          destination = { kind: 'output', index, offset: global - outputStart };
          break;
        }
        outputStart += v;
      }
      placements.push({ inputIndex, destination: destination ?? { kind: 'fee', offset: global - totalOut } });
    }
    inputStart += value;
  });
  return { placements, totalIn, totalOut, fee: f };
}

/** Convenience: the destination of the single inscribed sat, or throws when there is not exactly one. */
export function inscriptionDestination(inputs: SimInput[], outputs: SimOutput[], fee: bigint | number): SatDestination {
  const r = simulateOrdinalTransfer(inputs, outputs, fee);
  if (r.placements.length !== 1) throw new Error(`expected exactly one inscribed input, got ${r.placements.length}`);
  return r.placements[0]!.destination;
}
