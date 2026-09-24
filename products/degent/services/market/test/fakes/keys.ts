/** Deterministic test keys/addresses and a wallet emulator (signs PSBT inputs like UniSat would). */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { pubECDSA, pubSchnorr } from '@scure/btc-signer/utils.js';
import { networkParams, type Network } from '@bsh/inscription';

export const NET: Network = 'regtest';

export interface TestKey {
  priv: Uint8Array;
  publicKeyHex: string;
  tr: { address: string; script: Uint8Array; tweakedPubkey: Uint8Array };
  wpkh: { address: string; script: Uint8Array };
}

export function keyFromSeed(seed: string, network: Network = NET): TestKey {
  const priv = sha256(new TextEncoder().encode(`degent-test-${seed}`));
  const xonly = pubSchnorr(priv);
  const compressed = pubECDSA(priv, true);
  const params = networkParams(network);
  const tr = btc.p2tr(xonly, undefined, params);
  const wpkh = btc.p2wpkh(compressed, params);
  return {
    priv,
    publicKeyHex: hex.encode(compressed),
    tr: { address: tr.address!, script: tr.script, tweakedPubkey: tr.tweakedPubkey },
    wpkh: { address: wpkh.address!, script: wpkh.script },
  };
}

export const TXIDS = {
  inscription: 'a1'.repeat(32),
  dummy: 'b2'.repeat(32),
  pay1: 'c3'.repeat(32),
  pay2: 'd4'.repeat(32),
  pay3: 'e5'.repeat(32),
};
export const INSCRIPTION_ID = `${TXIDS.inscription}i0`;

/** Sign selected inputs of a PSBT (hex) with a private key, as a wallet would. */
export function walletSign(psbtHex: string, priv: Uint8Array, indexes: readonly number[], sighash?: number, opts: { finalize?: boolean } = {}): string {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  for (const i of indexes) {
    tx.signIdx(priv, i, sighash === undefined ? undefined : [sighash]);
    if (opts.finalize) tx.finalizeIdx(i);
  }
  return hex.encode(tx.toPSBT());
}

/** A malicious client: rebuild the PSBT with one output amount changed, then sign the buyer inputs. */
export function tamperOutput(psbtHex: string, outIdx: number, amount: bigint, priv: Uint8Array): string {
  const src = btc.Transaction.fromPSBT(hex.decode(psbtHex));
  const tx = new btc.Transaction();
  for (let i = 0; i < src.inputsLength; i++) {
    const { txid, index, witnessUtxo, tapInternalKey, sequence } = src.getInput(i);
    tx.addInput({ txid: txid!, index: index!, witnessUtxo: witnessUtxo!, sequence: sequence!, ...(tapInternalKey ? { tapInternalKey } : {}) });
  }
  for (let i = 0; i < src.outputsLength; i++) {
    const { script, amount: a } = src.getOutput(i);
    tx.addOutput({ script: script!, amount: i === outIdx ? amount : a! });
  }
  for (let i = 0; i < src.inputsLength; i++) {
    const w = src.getInput(i).finalScriptWitness;
    if (w) tx.updateInput(i, { finalScriptWitness: w }, true);
    else tx.signIdx(priv, i);
  }
  return hex.encode(tx.toPSBT());
}
