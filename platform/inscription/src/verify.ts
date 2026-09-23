import { schnorr } from '@noble/curves/secp256k1.js';
import { assertBytes, equalBytes } from './bytes.js';
import { addressToScript, commitAddress, NUMS_INTERNAL_KEY } from './commit.js';
import {
  LIMITS,
  REVEAL_LOCKTIME,
  REVEAL_SEQUENCE,
  REVEAL_TX_VERSION,
  SIGHASH_SINGLE_ANYONECANPAY,
  TAPSCRIPT_LEAF_VERSION,
} from './constants.js';
import type { InscriptionContent } from './envelope.js';
import type { Network } from './network.js';
import { decodePsbt, inputTxid } from './psbt.js';
import type { Outpoint } from './reveal.js';
import { revealCommitSighash } from './sighash.js';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Service side, before storing a user-supplied half-signed reveal. Everything the signature
 * commits to is recomputed from the order's expected values; nothing is trusted from the PSBT
 * except the signature itself.
 */
export function verifyHalfSignedReveal(args: {
  network: Network;
  psbtBase64: string;
  revealPubkey: Uint8Array;
  content: InscriptionContent;
  expectedCommitOutpoint: Outpoint;
  expectedCommitValue: bigint;
  expectedRecipientAddress: string;
  expectedPostage: bigint;
}): VerifyResult {
  const fail = (reason: string): VerifyResult => ({ ok: false, reason });
  try {
    assertBytes(args.revealPubkey, 32, 'revealPubkey');
    if (args.expectedPostage < LIMITS.DUST_P2TR) return fail(`expected postage below dust (${LIMITS.DUST_P2TR})`);
    if (args.expectedCommitValue <= args.expectedPostage) return fail('commit value does not exceed postage');

    let tx;
    try {
      tx = decodePsbt(args.psbtBase64);
    } catch (e) {
      return fail(`PSBT does not decode: ${(e as Error).message}`);
    }
    if (tx.inputsLength !== 1) return fail(`expected 1 input, got ${tx.inputsLength}`);
    if (tx.outputsLength !== 1) return fail(`expected 1 output, got ${tx.outputsLength}`);
    if (tx.version !== REVEAL_TX_VERSION) return fail(`nVersion must be ${REVEAL_TX_VERSION}`);
    if (tx.lockTime !== REVEAL_LOCKTIME) return fail(`nLockTime must be ${REVEAL_LOCKTIME}`);

    // Commit input: outpoint, value, script, sequence.
    const input = tx.getInput(0);
    const exp = args.expectedCommitOutpoint;
    if (inputTxid(tx, 0) !== exp.txid.toLowerCase() || input.index !== exp.vout)
      return fail('commit outpoint mismatch');
    if ((input.sequence ?? 0xffffffff) !== REVEAL_SEQUENCE) return fail('commit input nSequence mismatch');

    const commit = commitAddress(args.revealPubkey, args.content, args.network);
    const prev = input.witnessUtxo;
    if (!prev) return fail('commit input has no witnessUtxo');
    if (prev.amount !== args.expectedCommitValue) return fail('commit value mismatch');
    if (!equalBytes(prev.script, commit.script)) return fail('commit scriptPubKey mismatch (content, key or network)');

    // Leaf script: exactly the envelope for this content and key.
    const leaves = input.tapLeafScript;
    if (!leaves || leaves.length !== 1) return fail('commit input must carry exactly one tapLeafScript');
    const [cb, scriptWithVer] = leaves[0]!;
    if (scriptWithVer[scriptWithVer.length - 1] !== TAPSCRIPT_LEAF_VERSION) return fail('leaf version must be 0xc0');
    if (!equalBytes(scriptWithVer.subarray(0, -1), commit.leafScript))
      return fail('leaf script does not match the inscription script for this content');
    if (
      cb.version !== commit.controlBlock[0] ||
      !equalBytes(cb.internalKey, NUMS_INTERNAL_KEY) ||
      cb.merklePath.length !== 0
    )
      return fail('control block mismatch');
    if (input.sighashType !== undefined && input.sighashType !== SIGHASH_SINGLE_ANYONECANPAY)
      return fail('PSBT sighashType must be 0x83');

    // Child output.
    let recipientScript: Uint8Array;
    try {
      recipientScript = addressToScript(args.expectedRecipientAddress, args.network);
    } catch (e) {
      return fail(`expected recipient address invalid: ${(e as Error).message}`);
    }
    const child = tx.getOutput(0);
    if (!child.script || !equalBytes(child.script, recipientScript)) return fail('child output recipient mismatch');
    if (child.amount !== args.expectedPostage) return fail('child output postage mismatch');

    // Signature.
    const sigs = input.tapScriptSig;
    if (!sigs || sigs.length !== 1) return fail('commit input must carry exactly one tapscript signature');
    const [{ pubKey, leafHash }, sig] = sigs[0]!;
    if (!equalBytes(pubKey, args.revealPubkey)) return fail('signature pubkey is not the reveal key');
    if (!equalBytes(leafHash, commit.tapLeafHash)) return fail('signature leaf hash mismatch');
    if (sig.length !== 65) return fail(`signature must be 65 bytes, got ${sig.length}`);
    if (sig[64] !== SIGHASH_SINGLE_ANYONECANPAY) return fail(`sighash type must be 0x83, got 0x${sig[64]!.toString(16)}`);
    const digest = revealCommitSighash({
      commitOutpoint: exp,
      commitValue: args.expectedCommitValue,
      commitScript: commit.script,
      childScript: recipientScript,
      childValue: args.expectedPostage,
      tapLeafHash: commit.tapLeafHash,
    });
    if (!schnorr.verify(sig.subarray(0, 64), digest, args.revealPubkey)) return fail('schnorr signature does not verify');
    return { ok: true };
  } catch (e) {
    return fail(`verification error: ${(e as Error).message}`);
  }
}
