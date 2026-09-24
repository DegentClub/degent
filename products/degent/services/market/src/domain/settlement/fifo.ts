/**
 * The inscription-destination guard. There is no FIFO calculator in this service: where the
 * inscribed sat lands is decided by `@bsh/inscription` (`assertNoInscriptionBurn` / `assignSats`,
 * ord's first-in-first-out rule), the same implementation the mint and the platform tests use.
 *
 * The purchase layout deliberately puts two funding (padding) inputs AHEAD of the inscription, so
 * the platform's burn-proof invariant (`checkInscriptionCoverage`: inscription inputs first) does not
 * hold by construction. That is why every purchase is checked explicitly: the inscription must land in
 * output #1, the buyer's postage output, at its original offset, before a PSBT is handed out and again
 * on the exact bytes before broadcast.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { equalBytes } from '@scure/btc-signer/utils.js';
import { assertNoInscriptionBurn, InscriptionBurnError, type SatInput, type SatOutput } from '@bsh/inscription';
import { INSCRIPTION_INPUT_INDEX, INSCRIPTION_OUTPUT_INDEX } from '@bsh/degent-market-sdk';
import { SettlementError } from '../errors.js';

export interface InscriptionGuard {
  /** Offset of the inscribed sat inside the inscription UTXO. */
  satOffset: number | bigint;
  /** Output #1 must pay this script (the buyer's). */
  buyerScript: Uint8Array;
  inscriptionId?: string;
  /** Postage the buyer receives; output #1 must carry exactly this value. */
  postage: bigint;
}

export interface GuardResult {
  vout: number;
  offset: bigint;
}

/** Values of a transaction's inputs (from witness_utxo) and outputs, as `@bsh/inscription` expects them. */
export function satShape(tx: btc.Transaction): { inputs: SatInput[]; outputs: SatOutput[] } {
  const inputs: SatInput[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const amount = tx.getInput(i).witnessUtxo?.amount;
    if (amount === undefined) throw new SettlementError('bad_psbt', `input ${i} lacks witness_utxo`);
    inputs.push({ value: amount });
  }
  const outputs: SatOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const amount = tx.getOutput(i).amount;
    if (amount === undefined) throw new SettlementError('bad_psbt', `output ${i} has no amount`);
    outputs.push({ value: amount });
  }
  return { inputs, outputs };
}

/**
 * Assert, with `@bsh/inscription`, that the inscription on input #2 lands in output #1 (the buyer's
 * postage) at its original offset, is not burned to fee, and that output #1 pays the buyer exactly the
 * postage. Pure over values + the output script; throws `SettlementError('inscription_misrouted')`.
 */
export function assertInscriptionToBuyer(
  shape: { inputs: SatInput[]; outputs: SatOutput[]; outputScripts: Uint8Array[] },
  g: InscriptionGuard,
): GuardResult {
  if (shape.inputs.length <= INSCRIPTION_INPUT_INDEX) throw new SettlementError('inscription_misrouted', 'transaction has no inscription input at index 2');
  const id = g.inscriptionId ?? 'listed-inscription';
  const inputs = shape.inputs.map((inp, i) => (i === INSCRIPTION_INPUT_INDEX ? { value: inp.value, inscriptions: [{ id, offset: g.satOffset }] } : { value: inp.value }));
  let placement;
  try {
    placement = assertNoInscriptionBurn(inputs, shape.outputs).placements[0]!;
  } catch (e) {
    if (e instanceof InscriptionBurnError) throw new SettlementError('inscription_misrouted', 'refusing: the inscription would be burned to the miner fee');
    throw new SettlementError('inscription_misrouted', `refusing: ${e instanceof Error ? e.message : String(e)}`);
  }
  const d = placement.destination;
  if (d === 'fee') throw new SettlementError('inscription_misrouted', 'refusing: the inscription would be burned to the miner fee');
  if (d.vout !== INSCRIPTION_OUTPUT_INDEX)
    throw new SettlementError('inscription_misrouted', `refusing: the inscription would land in output ${d.vout}, expected ${INSCRIPTION_OUTPUT_INDEX}`, { vout: d.vout });
  if (d.offset !== BigInt(g.satOffset)) throw new SettlementError('inscription_misrouted', `refusing: the inscription would move to offset ${d.offset} of output 1`);
  const script = shape.outputScripts[INSCRIPTION_OUTPUT_INDEX];
  if (!script || !equalBytes(script, g.buyerScript)) throw new SettlementError('inscription_misrouted', 'refusing: output 1 does not pay the buyer');
  if (BigInt(shape.outputs[INSCRIPTION_OUTPUT_INDEX]!.value) !== g.postage) throw new SettlementError('inscription_misrouted', 'refusing: output 1 is not exactly the postage');
  return { vout: d.vout, offset: d.offset };
}

/** The guard on a PSBT-level transaction (inputs carry witness_utxo). */
export function assertTxInscriptionToBuyer(tx: btc.Transaction, g: InscriptionGuard): GuardResult {
  const { inputs, outputs } = satShape(tx);
  const outputScripts: Uint8Array[] = [];
  for (let i = 0; i < tx.outputsLength; i++) outputScripts.push(tx.getOutput(i).script ?? new Uint8Array());
  return assertInscriptionToBuyer({ inputs, outputs, outputScripts }, g);
}

/**
 * The guard on the exact raw bytes about to be broadcast: outputs are decoded from the raw transaction;
 * input values come from the prevouts the session committed to, matched by outpoint.
 */
export function assertRawInscriptionToBuyer(rawHex: string, prevouts: ReadonlyMap<string, bigint>, g: InscriptionGuard): GuardResult {
  let raw: ReturnType<typeof btc.RawTx.decode>;
  try {
    raw = btc.RawTx.decode(hex.decode(rawHex));
  } catch {
    throw new SettlementError('bad_psbt', 'final transaction does not decode');
  }
  const inputs = raw.inputs.map((inp) => {
    const key = `${hex.encode(inp.txid)}:${inp.index}`;
    const value = prevouts.get(key);
    if (value === undefined) throw new SettlementError('inscription_misrouted', `refusing: final transaction spends an unexpected outpoint ${key}`);
    return { value };
  });
  if (inputs.length !== prevouts.size) throw new SettlementError('inscription_misrouted', 'refusing: final transaction input set differs from the session');
  return assertInscriptionToBuyer({ inputs, outputs: raw.outputs.map((o) => ({ value: o.amount })), outputScripts: raw.outputs.map((o) => o.script) }, g);
}
