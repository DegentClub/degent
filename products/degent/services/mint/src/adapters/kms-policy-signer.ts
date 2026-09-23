/**
 * TODO(production): KMS/HSM-backed PolicySigner. Not implemented; the service refuses to start on
 * mainnet until this exists (config.ts). Intended shape:
 *
 *   1. evaluateParentPolicy(psbt, ctx) exactly as InMemoryPolicySigner does; refuse on violation.
 *   2. Compute the BIP341 SIGHASH_DEFAULT key-path digest for input 0 (both prevouts known from
 *      the PSBT's witnessUtxo fields).
 *   3. Ask the HSM for a BIP340 Schnorr signature over the digest with the TWEAKED key
 *      (tweak = H_TapTweak(P), no script tree) - either the HSM supports taproot tweaking or the
 *      tweaked private key is what is stored in the HSM.
 *   4. Put the 64-byte signature in input 0's tapKeySig and return the PSBT.
 *   5. Audit-log orderId, parent outpoint, digest and verdict for every request.
 */
import type { PolicySigner } from '../ports/policy-signer.js';

export interface SchnorrSigningBackend {
  /** Public x-only key of the (tweaked) signing key, for startup cross-checks. */
  publicKey(): Promise<Uint8Array>;
  /** BIP340 signature over a 32-byte digest; the key never leaves the backend. */
  signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}

export type KmsPolicySignerFactory = (backend: SchnorrSigningBackend) => PolicySigner;
