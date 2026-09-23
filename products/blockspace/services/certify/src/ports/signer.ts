/**
 * Signs attestation digests with BIP340 Schnorr. Production: a KMS/HSM-backed adapter (secret path
 * `services/blockspace-certify/attestation-key`); tests and dev: `adapters/memory-signer.ts`.
 * The key signs only 32-byte tagged-hash digests of attestations; it controls no funds.
 */
export interface AttestationSigner {
  /** First 8 bytes of sha256(publicKey), hex. */
  readonly keyId: string;
  /** 32-byte x-only public key. */
  readonly publicKey: Uint8Array;
  /** 64-byte BIP340 signature over exactly 32 bytes. */
  sign(digest: Uint8Array): Promise<Uint8Array>;
}
