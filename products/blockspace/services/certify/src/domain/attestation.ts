/**
 * Attestation signing and verification.
 *
 * digest    = taggedHash("block.space/collection-attestation/v1", canonicalJson(attestation minus `signature`))
 * signature = BIP340 Schnorr(digest) with the key named by `keyId` (published at GET /v1/keys)
 *
 * `verifyAttestation` needs nothing but this file, @noble/curves and the public key, so anyone can
 * check a "Verified by block.space" badge offline.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from './canonical-json.js';
import { bytesToHex, taggedHash } from './hash.js';
import { ATTESTATION_TAG, type Attestation, type UnsignedAttestation } from './model.js';
import type { AttestationSigner } from '../ports/signer.js';

export function attestationDigest(a: UnsignedAttestation): Uint8Array {
  const { signature: _drop, ...unsigned } = a as Attestation;
  return taggedHash(ATTESTATION_TAG, canonicalJson(unsigned));
}

export async function signAttestation(a: Omit<UnsignedAttestation, 'keyId'>, signer: AttestationSigner): Promise<{ attestation: Attestation; digest: string }> {
  const unsigned: UnsignedAttestation = { ...a, keyId: signer.keyId };
  const digest = attestationDigest(unsigned);
  const sig = await signer.sign(digest);
  return { attestation: { ...unsigned, signature: bytesToHex(sig) }, digest: bytesToHex(digest) };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'bad_signature' };

/** @param publicKeyHex 32-byte x-only key, hex (from GET /v1/keys). */
export function verifyAttestation(a: Attestation, publicKeyHex: string): VerifyResult {
  if (!/^[0-9a-f]{128}$/.test(a.signature ?? '') || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return { ok: false, reason: 'malformed' };
  let digest: Uint8Array;
  try {
    digest = attestationDigest(a);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let ok = false;
  try {
    ok = schnorr.verify(hexToBytes(a.signature), digest, hexToBytes(publicKeyHex));
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
