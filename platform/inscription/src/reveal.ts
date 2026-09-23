import { schnorr } from '@noble/curves/secp256k1.js';
import { p2tr, Transaction } from '@scure/btc-signer';
import { assertBytes, equalBytes } from './bytes.js';
import { commitAddress, addressToScript, NUMS_INTERNAL_KEY } from './commit.js';
import {
  LIMITS,
  REVEAL_LOCKTIME,
  REVEAL_SEQUENCE,
  REVEAL_TX_VERSION,
  SIGHASH_SINGLE_ANYONECANPAY,
  TAPSCRIPT_LEAF_VERSION,
} from './constants.js';
import type { InscriptionContent } from './envelope.js';
import { networkParams, type Network } from './network.js';
import { decodePsbt, encodePsbt, inputTxid, rawFacts, TX_OPTS } from './psbt.js';
import { revealCommitSighash } from './sighash.js';

export interface Outpoint {
  txid: string;
  vout: number;
}

function checkOutpoint(o: Outpoint, name: string): void {
  if (!o || typeof o.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(o.txid)) throw new Error(`${name}.txid invalid`);
  if (!Number.isSafeInteger(o.vout) || o.vout < 0 || o.vout > 0xffffffff) throw new Error(`${name}.vout invalid`);
}

function isP2TR(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

/** The 65-byte 0x83 tapscript signature on a half-signed commit input, or undefined. */
export function commitSignature(tx: Transaction, idx: number): Uint8Array | undefined {
  const sigs = tx.getInput(idx).tapScriptSig;
  if (!sigs || sigs.length !== 1) return undefined;
  return sigs[0]![1];
}

/** Structural checks shared by attachParent / buildRescueReveal. */
function assertHalfSigned(tx: Transaction): void {
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1)
    throw new Error(`half-signed reveal must have exactly 1 input and 1 output (got ${tx.inputsLength}/${tx.outputsLength})`);
  if (tx.version !== REVEAL_TX_VERSION || tx.lockTime !== REVEAL_LOCKTIME)
    throw new Error('half-signed reveal must have nVersion=2 and nLockTime=0');
  const sig = commitSignature(tx, 0);
  if (!sig || sig.length !== 65 || sig[64] !== SIGHASH_SINGLE_ANYONECANPAY)
    throw new Error('commit input must carry exactly one 65-byte SIGHASH_SINGLE|ANYONECANPAY signature');
  if ((tx.getInput(0).sequence ?? 0xffffffff) !== REVEAL_SEQUENCE) throw new Error('commit input nSequence mismatch');
}

/**
 * Browser side. Builds the reveal in its "half-signed" form: [commit] -> [child], commit input
 * signed with 0x83. Because commit input and child output share an index and 0x83 omits
 * input_index, this exact signature also validates when attachParent shifts both to index 1.
 * The half-signed PSBT is therefore also the rescue transaction.
 */
export function buildHalfSignedReveal(args: {
  network: Network;
  revealPrivkey: Uint8Array;
  content: InscriptionContent;
  commitOutpoint: Outpoint;
  commitValue: bigint;
  recipientAddress: string;
  postage: bigint;
}): { psbtBase64: string; signature: Uint8Array } {
  assertBytes(args.revealPrivkey, 32, 'revealPrivkey');
  checkOutpoint(args.commitOutpoint, 'commitOutpoint');
  if (typeof args.postage !== 'bigint' || args.postage < LIMITS.DUST_P2TR)
    throw new Error(`postage must be a bigint >= ${LIMITS.DUST_P2TR}`);
  if (typeof args.commitValue !== 'bigint' || args.commitValue <= args.postage)
    throw new Error('commitValue must exceed postage (fee = commitValue - postage)');

  const revealPubkey = schnorr.getPublicKey(args.revealPrivkey);
  const commit = commitAddress(revealPubkey, args.content, args.network);
  const recipientScript = addressToScript(args.recipientAddress, args.network);

  const tx = new Transaction(TX_OPTS);
  tx.addOutput({ script: recipientScript, amount: args.postage });
  tx.addInput({
    txid: args.commitOutpoint.txid,
    index: args.commitOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: args.commitValue },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [
      [
        { version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] },
        new Uint8Array([...commit.leafScript, TAPSCRIPT_LEAF_VERSION]),
      ],
    ],
    sighashType: SIGHASH_SINGLE_ANYONECANPAY,
  });
  tx.signIdx(args.revealPrivkey, 0, [SIGHASH_SINGLE_ANYONECANPAY]);
  const signature = commitSignature(tx, 0);
  if (!signature || signature.length !== 65) throw new Error('internal: commit input was not signed');

  // Defence in depth: the signature must verify against our independent BIP341 digest.
  const digest = revealCommitSighash({
    commitOutpoint: args.commitOutpoint,
    commitValue: args.commitValue,
    commitScript: commit.script,
    childScript: recipientScript,
    childValue: args.postage,
    tapLeafHash: commit.tapLeafHash,
  });
  if (!schnorr.verify(signature.subarray(0, 64), digest, revealPubkey))
    throw new Error('internal: signature does not verify against independent sighash');

  return { psbtBase64: encodePsbt(tx), signature: Uint8Array.from(signature) };
}

/**
 * Service side. Returns [parent, commit] -> [parent return, child]. The parent return carries
 * exactly `parentValue`: ord puts the new inscription on the first sat of the commit input, i.e.
 * at offset `parentValue`, which must be the first sat of output 1 (the child).
 */
export function attachParent(args: {
  network: Network;
  halfSignedPsbtBase64: string;
  parentOutpoint: Outpoint;
  parentValue: bigint;
  parentScript: Uint8Array;
  parentReturnAddress: string;
}): { psbtBase64: string } {
  checkOutpoint(args.parentOutpoint, 'parentOutpoint');
  assertBytes(args.parentScript, undefined, 'parentScript');
  if (!isP2TR(args.parentScript)) throw new Error('parentScript must be a P2TR scriptPubKey');
  if (typeof args.parentValue !== 'bigint' || args.parentValue <= 0n) throw new Error('parentValue must be a positive bigint');

  const half = decodePsbt(args.halfSignedPsbtBase64);
  assertHalfSigned(half);
  const commitIn = half.getInput(0);
  const child = half.getOutput(0);
  if (
    inputTxid(half, 0) === args.parentOutpoint.txid.toLowerCase() &&
    commitIn.index === args.parentOutpoint.vout
  )
    throw new Error('parent outpoint equals commit outpoint');
  const parentReturnScript = addressToScript(args.parentReturnAddress, args.network);

  const tx = new Transaction(TX_OPTS);
  // Outputs first: once the 0x83-signed input is present btc-signer (correctly) forbids adding
  // the output at its index.
  tx.addOutput({ script: parentReturnScript, amount: args.parentValue });
  tx.addOutput({ script: child.script!, amount: child.amount! });
  tx.addInput({
    txid: args.parentOutpoint.txid,
    index: args.parentOutpoint.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: args.parentScript, amount: args.parentValue },
  });
  tx.addInput(commitIn);
  return { psbtBase64: encodePsbt(tx) };
}

/**
 * Service/policy signer. Key-path (SIGHASH_DEFAULT, 64-byte sig) spend of input 0, whose
 * scriptPubKey must be the BIP86-style P2TR of `parentPrivkey` (tweaked, no script tree).
 */
export function signParentInput(psbtBase64: string, parentPrivkey: Uint8Array): { psbtBase64: string } {
  assertBytes(parentPrivkey, 32, 'parentPrivkey');
  const tx = decodePsbt(psbtBase64);
  if (tx.inputsLength !== 2 || tx.outputsLength !== 2) throw new Error('parent reveal must have 2 inputs and 2 outputs');
  const parentIn = tx.getInput(0);
  const prev = parentIn.witnessUtxo;
  if (!prev) throw new Error('parent input has no witnessUtxo');
  const out0 = tx.getOutput(0);
  if (out0.amount !== prev.amount)
    throw new Error('parent return value must equal parent input value (child sat placement)');
  const internal = schnorr.getPublicKey(parentPrivkey);
  if (!equalBytes(p2tr(internal).script, prev.script)) throw new Error('parentPrivkey does not control input 0');
  if (!commitSignature(tx, 1)) throw new Error('commit input (index 1) is not signed');
  tx.updateInput(0, { tapInternalKey: internal });
  tx.signIdx(parentPrivkey, 0);
  return { psbtBase64: encodePsbt(tx) };
}

function finalizeAll(tx: Transaction): void {
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const signed =
      !!inp.tapKeySig ||
      !!(inp.tapScriptSig && inp.tapScriptSig.length) ||
      !!(inp.finalScriptWitness && inp.finalScriptWitness.length);
    if (!signed) throw new Error(`input ${i} is unsigned`);
  }
  tx.finalize();
}

/** Finalize to raw hex. Throws if any input is unsigned. */
export function finalizeReveal(psbtBase64: string): { hex: string; txid: string; weight: number; vsize: number } {
  const tx = decodePsbt(psbtBase64);
  finalizeAll(tx);
  return rawFacts(tx);
}

/** Self-rescue: [commit] -> [child], same 0x83 signature, no parent. */
export function buildRescueReveal(args: { network: Network; halfSignedPsbtBase64: string }): {
  hex: string;
  txid: string;
  weight: number;
  vsize: number;
} {
  const tx = decodePsbt(args.halfSignedPsbtBase64);
  assertHalfSigned(tx);
  networkParams(args.network); // validates the network name
  finalizeAll(tx);
  return rawFacts(tx);
}
