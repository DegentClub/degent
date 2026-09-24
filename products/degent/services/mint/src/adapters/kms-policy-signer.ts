/**
 * RETIRED (Phase 5, p5.1): the KMS/HSM path is the platform signer service. `SIGNER=kms` is refused by
 * config.ts with a pointer to `SIGNER=remote`: the mint talks to `@bsh/signer` through
 * `RemotePolicySigner` (adapters/remote-policy-signer.ts), and the HSM sits behind the signer's
 * `KeyProvider` port (platform/signer README, "HSM path"), so no key or HSM session ever lives in this
 * process. The shapes below are kept only so older notes that reference them still resolve; nothing wires them.
 */
import type { PolicySigner } from '../ports/policy-signer.js';

/** @deprecated Use the platform signer's `KeyProvider` / `HsmKeyProvider` behind `SIGNER=remote`. */
export interface SchnorrSigningBackend {
  /** Public x-only key of the (tweaked) signing key, for startup cross-checks. */
  publicKey(): Promise<Uint8Array>;
  /** BIP340 signature over a 32-byte digest; the key never leaves the backend. */
  signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}

/** @deprecated See `RemotePolicySigner`. */
export type KmsPolicySignerFactory = (backend: SchnorrSigningBackend) => PolicySigner;
