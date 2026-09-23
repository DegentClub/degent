/**
 * BIP-322 "simple" signed messages: verification (P2TR key-path, P2WPKH) and a reference signer.
 *
 * https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 *   to_spend: nVersion 0, nLockTime 0
 *     vin[0]  = 000..000:0xFFFFFFFF, scriptSig = OP_0 PUSH32[message_hash], nSequence 0
 *     vout[0] = 0 sat, scriptPubKey = message_challenge (the address' scriptPubKey)
 *   to_sign:  nVersion 0, nLockTime 0
 *     vin[0]  = to_spend.txid:0, scriptSig empty, nSequence 0, witness = message_signature
 *     vout[0] = 0 sat, scriptPubKey = OP_RETURN
 *
 * The "simple" signature is the consensus-encoded witness stack of to_sign.vin[0], base64.
 * Everything here is written out byte-for-byte (no PSBT machinery) so the digest is auditable.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { taprootTweakPrivKey, taprootTweakPubkey } from '@scure/btc-signer/utils.js';
import { compactSize, concatBytes, decodeBase64, encodeBase64, equalBytes, Reader, u32le, u64le, utf8, varBytes } from './bytes.js';
import { decodeAddress, type DecodedAddress } from './address.js';
import type { BitcoinNetwork } from './network.js';

export const BIP322_TAG = 'BIP0322-signed-message';
export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;

const OP_0 = 0x00;
const OP_RETURN = 0x6a;
const ZERO32 = new Uint8Array(32);

export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));
export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b));

/** BIP340-style tagged hash: sha256(sha256(tag) || sha256(tag) || msg...). */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const t = sha256(utf8(tag));
  return sha256(concatBytes(t, t, ...msgs));
}

const asBytes = (m: string | Uint8Array): Uint8Array => (typeof m === 'string' ? utf8(m) : m);

/** message_hash = tagged_hash("BIP0322-signed-message", message). */
export function bip322MessageHash(message: string | Uint8Array): Uint8Array {
  return taggedHash(BIP322_TAG, asBytes(message));
}

interface VirtualTx {
  version: number;
  locktime: number;
  prevTxid: Uint8Array; // internal byte order
  prevVout: number;
  scriptSig: Uint8Array;
  sequence: number;
  outValue: bigint;
  outScript: Uint8Array;
}

/** Non-witness serialization (the one that hashes to the txid). */
function serializeNoWitness(tx: VirtualTx): Uint8Array {
  return concatBytes(
    u32le(tx.version),
    Uint8Array.of(1),
    tx.prevTxid,
    u32le(tx.prevVout),
    varBytes(tx.scriptSig),
    u32le(tx.sequence),
    Uint8Array.of(1),
    u64le(tx.outValue),
    varBytes(tx.outScript),
    u32le(tx.locktime),
  );
}

function toSpendTx(messageChallenge: Uint8Array, message: string | Uint8Array): VirtualTx {
  return {
    version: 0,
    locktime: 0,
    prevTxid: ZERO32,
    prevVout: 0xffffffff,
    scriptSig: concatBytes(Uint8Array.of(OP_0, 0x20), bip322MessageHash(message)),
    sequence: 0,
    outValue: 0n,
    outScript: messageChallenge,
  };
}

function toSignTx(toSpendTxid: Uint8Array): VirtualTx {
  return {
    version: 0,
    locktime: 0,
    prevTxid: toSpendTxid,
    prevVout: 0,
    scriptSig: new Uint8Array(0),
    sequence: 0,
    outValue: 0n,
    outScript: Uint8Array.of(OP_RETURN),
  };
}

/** Display-order (RPC / explorer) hex of a txid given in internal byte order. */
export const txidHex = (internal: Uint8Array): string =>
  Array.from(internal)
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export interface Bip322VirtualTxs {
  /** to_spend txid, internal byte order. */
  toSpendTxid: Uint8Array;
  /** to_sign txid (witness excluded), internal byte order. */
  toSignTxid: Uint8Array;
}

/** Build the two virtual transactions and return their txids (exposed for test vectors / debugging). */
export function bip322VirtualTxids(messageChallenge: Uint8Array, message: string | Uint8Array): Bip322VirtualTxs {
  const toSpendTxid = sha256d(serializeNoWitness(toSpendTx(messageChallenge, message)));
  const toSignTxid = sha256d(serializeNoWitness(toSignTx(toSpendTxid)));
  return { toSpendTxid, toSignTxid };
}

/** BIP143 (segwit v0) SIGHASH_ALL digest of to_sign input 0 for a P2WPKH challenge. */
export function bip322SighashP2wpkh(pubkeyHash: Uint8Array, message: string | Uint8Array): Uint8Array {
  if (pubkeyHash.length !== 20) throw new Error('pubkeyHash must be 20 bytes');
  const challenge = concatBytes(Uint8Array.of(0x00, 0x14), pubkeyHash);
  const toSpendTxid = sha256d(serializeNoWitness(toSpendTx(challenge, message)));
  const tx = toSignTx(toSpendTxid);
  const outpoint = concatBytes(tx.prevTxid, u32le(tx.prevVout));
  const hashPrevouts = sha256d(outpoint);
  const hashSequence = sha256d(u32le(tx.sequence));
  const hashOutputs = sha256d(concatBytes(u64le(tx.outValue), varBytes(tx.outScript)));
  // scriptCode for P2WPKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG, length-prefixed.
  const scriptCode = varBytes(concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), pubkeyHash, Uint8Array.of(0x88, 0xac)));
  const preimage = concatBytes(
    u32le(tx.version),
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCode,
    u64le(0n), // amount of the to_spend output
    u32le(tx.sequence),
    hashOutputs,
    u32le(tx.locktime),
    u32le(SIGHASH_ALL),
  );
  return sha256d(preimage);
}

/** BIP341 key-path digest of to_sign input 0 for a P2TR challenge (SIGHASH_DEFAULT or SIGHASH_ALL). */
export function bip322SighashP2tr(outputKey: Uint8Array, message: string | Uint8Array, hashType: number): Uint8Array {
  if (outputKey.length !== 32) throw new Error('outputKey must be 32 bytes');
  if (hashType !== SIGHASH_DEFAULT && hashType !== SIGHASH_ALL) throw new Error('unsupported sighash type');
  const challenge = concatBytes(Uint8Array.of(0x51, 0x20), outputKey);
  const toSpendTxid = sha256d(serializeNoWitness(toSpendTx(challenge, message)));
  const tx = toSignTx(toSpendTxid);
  const shaPrevouts = sha256(concatBytes(tx.prevTxid, u32le(tx.prevVout)));
  const shaAmounts = sha256(u64le(0n));
  const shaScriptPubkeys = sha256(varBytes(challenge));
  const shaSequences = sha256(u32le(tx.sequence));
  const shaOutputs = sha256(concatBytes(u64le(tx.outValue), varBytes(tx.outScript)));
  const sigMsg = concatBytes(
    Uint8Array.of(0x00), // epoch
    Uint8Array.of(hashType),
    u32le(tx.version),
    u32le(tx.locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptPubkeys,
    shaSequences,
    shaOutputs,
    Uint8Array.of(0x00), // spend_type: key path, no annex
    u32le(0), // input_index
  );
  return taggedHash('TapSighash', sigMsg);
}

/** Decode a consensus-encoded witness stack (the BIP-322 "simple" payload). Rejects trailing bytes. */
export function decodeWitness(raw: Uint8Array): Uint8Array[] {
  const r = new Reader(raw);
  const n = r.compactSize();
  if (n > 100) throw new Error('witness has too many items');
  const items: Uint8Array[] = [];
  for (let i = 0; i < n; i++) items.push(Uint8Array.from(r.bytes(r.compactSize())));
  if (r.remaining !== 0) throw new Error('trailing bytes after witness');
  return items;
}

export function encodeWitness(items: Uint8Array[]): Uint8Array {
  return concatBytes(compactSize(items.length), ...items.map(varBytes));
}

export type Bip322Result = { valid: true; kind: 'p2tr' | 'p2wpkh' } | { valid: false; reason: string };

/** Verify a BIP-322 simple signature against an already-decoded address. Never throws. */
export function verifyBip322SimpleDecoded(
  decoded: DecodedAddress,
  message: string | Uint8Array,
  signatureBase64: string,
): Bip322Result {
  let witness: Uint8Array[];
  try {
    witness = decodeWitness(decodeBase64(signatureBase64));
  } catch (e) {
    return { valid: false, reason: `malformed signature: ${(e as Error).message}` };
  }
  try {
    if (decoded.kind === 'p2tr') {
      // Key path only: exactly one element, no annex, no script path.
      if (witness.length !== 1) return { valid: false, reason: 'p2tr: expected a single key-path signature' };
      const sig = witness[0]!;
      let hashType: number;
      if (sig.length === 64) hashType = SIGHASH_DEFAULT;
      else if (sig.length === 65 && sig[64] === SIGHASH_ALL) hashType = SIGHASH_ALL;
      else return { valid: false, reason: 'p2tr: signature must be 64 bytes or 65 bytes with SIGHASH_ALL' };
      const digest = bip322SighashP2tr(decoded.program, message, hashType);
      const ok = schnorr.verify(sig.subarray(0, 64), digest, decoded.program);
      return ok ? { valid: true, kind: 'p2tr' } : { valid: false, reason: 'p2tr: schnorr signature invalid' };
    }
    if (decoded.kind === 'p2wpkh') {
      if (witness.length !== 2) return { valid: false, reason: 'p2wpkh: expected [signature, pubkey]' };
      const [sigWithType, pubkey] = witness as [Uint8Array, Uint8Array];
      if (pubkey.length !== 33 || (pubkey[0] !== 0x02 && pubkey[0] !== 0x03))
        return { valid: false, reason: 'p2wpkh: pubkey must be 33-byte compressed' };
      if (!equalBytes(hash160(pubkey), decoded.program)) return { valid: false, reason: 'p2wpkh: pubkey does not match address' };
      if (sigWithType.length < 9 || sigWithType[sigWithType.length - 1] !== SIGHASH_ALL)
        return { valid: false, reason: 'p2wpkh: signature must be DER with SIGHASH_ALL' };
      const der = sigWithType.subarray(0, sigWithType.length - 1);
      const digest = bip322SighashP2wpkh(decoded.program, message);
      // lowS: BIP-322 verification applies the standard policy flags, which include LOW_S.
      const ok = secp256k1.verify(der, digest, pubkey, { prehash: false, lowS: true, format: 'der' });
      return ok ? { valid: true, kind: 'p2wpkh' } : { valid: false, reason: 'p2wpkh: ecdsa signature invalid' };
    }
    return { valid: false, reason: `BIP-322 simple is not supported for ${decoded.kind} addresses` };
  } catch (e) {
    return { valid: false, reason: `verification error: ${(e as Error).message}` };
  }
}

/** Verify a BIP-322 simple signature. Never throws; `valid:false` carries a reason for logs (not for users). */
export function verifyBip322Simple(
  address: string,
  network: BitcoinNetwork,
  message: string | Uint8Array,
  signatureBase64: string,
): Bip322Result {
  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(address, network);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
  return verifyBip322SimpleDecoded(decoded, message, signatureBase64);
}

/**
 * Reference BIP-322 simple signer (tests, regtest tooling, CLI). Services must never hold user keys
 * (CLAUDE.md rule 6); wallets sign in the browser.
 */
export function signBip322Simple(
  privateKey: Uint8Array,
  kind: 'p2tr' | 'p2wpkh',
  message: string | Uint8Array,
  opts: { hashType?: number; auxRand?: Uint8Array } = {},
): string {
  if (kind === 'p2wpkh') {
    const pubkey = secp256k1.getPublicKey(privateKey, true);
    const digest = bip322SighashP2wpkh(hash160(pubkey), message);
    const der = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: 'der' });
    return encodeBase64(encodeWitness([concatBytes(der, Uint8Array.of(SIGHASH_ALL)), pubkey]));
  }
  const hashType = opts.hashType ?? SIGHASH_DEFAULT;
  const internal = schnorr.getPublicKey(privateKey);
  const [outputKey] = taprootTweakPubkey(internal, new Uint8Array(0));
  const tweaked = taprootTweakPrivKey(privateKey, new Uint8Array(0));
  const digest = bip322SighashP2tr(outputKey, message, hashType);
  const sig = schnorr.sign(digest, tweaked, opts.auxRand);
  const full = hashType === SIGHASH_DEFAULT ? sig : concatBytes(sig, Uint8Array.of(hashType));
  return encodeBase64(encodeWitness([full]));
}
