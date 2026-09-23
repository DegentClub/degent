import { sha256 } from '@noble/hashes/sha2.js';
import { compactSize, concatBytes, i32le, txidToInternal, u32le, u64le, utf8 } from './bytes.js';
import { REVEAL_LOCKTIME, REVEAL_SEQUENCE, REVEAL_TX_VERSION, SIGHASH_SINGLE_ANYONECANPAY } from './constants.js';

const TAG = sha256(utf8('TapSighash'));

function taggedHash(msg: Uint8Array): Uint8Array {
  return sha256(concatBytes(TAG, TAG, msg));
}

/**
 * Independent BIP341/BIP342 signature hash for the commit input, hash type 0x83
 * (SIGHASH_SINGLE | SIGHASH_ANYONECANPAY), script-path spend, no annex, no OP_CODESEPARATOR.
 *
 * Note what is NOT an argument: the input index, the other inputs and the other outputs. That
 * is why the same signature is valid whether the commit input sits at index 0 (rescue layout)
 * or index 1 (parent layout), as long as the child output sits at the same index as the input.
 */
export function revealCommitSighash(args: {
  commitOutpoint: { txid: string; vout: number };
  commitValue: bigint;
  commitScript: Uint8Array;
  childScript: Uint8Array;
  childValue: bigint;
  tapLeafHash: Uint8Array;
  version?: number;
  lockTime?: number;
  sequence?: number;
}): Uint8Array {
  const version = args.version ?? REVEAL_TX_VERSION;
  const lockTime = args.lockTime ?? REVEAL_LOCKTIME;
  const sequence = args.sequence ?? REVEAL_SEQUENCE;
  const shaSingleOutput = sha256(
    concatBytes(u64le(args.childValue), compactSize(args.childScript.length), args.childScript),
  );
  const msg = concatBytes(
    Uint8Array.of(0x00), // epoch
    Uint8Array.of(SIGHASH_SINGLE_ANYONECANPAY),
    i32le(version),
    u32le(lockTime),
    // ANYONECANPAY: no sha_prevouts / sha_amounts / sha_scriptpubkeys / sha_sequences
    // SINGLE: no sha_outputs
    Uint8Array.of(0x02), // spend_type = ext_flag(1)*2 + annex_present(0)
    txidToInternal(args.commitOutpoint.txid),
    u32le(args.commitOutpoint.vout),
    u64le(args.commitValue),
    compactSize(args.commitScript.length),
    args.commitScript,
    u32le(sequence),
    shaSingleOutput,
    // BIP342 extension
    args.tapLeafHash,
    Uint8Array.of(0x00), // key_version
    u32le(0xffffffff), // codesep_pos: none
  );
  return taggedHash(msg);
}
