import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { AttestationSigner } from '../ports/signer.js';

export function keyIdOf(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey).subarray(0, 8));
}

/** Holds a secp256k1 secret key in memory. Dev/test, or production only behind a secret store. */
export class InMemoryAttestationSigner implements AttestationSigner {
  readonly publicKey: Uint8Array;
  readonly keyId: string;
  readonly #secret: Uint8Array;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new Error('attestation secret key must be 32 bytes');
    this.#secret = Uint8Array.from(secretKey);
    this.publicKey = schnorr.getPublicKey(this.#secret);
    this.keyId = keyIdOf(this.publicKey);
  }

  static fromHex(hex: string): InMemoryAttestationSigner {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('attestation secret key must be 64 hex characters');
    return new InMemoryAttestationSigner(hexToBytes(hex.toLowerCase()));
  }

  static random(): InMemoryAttestationSigner {
    return new InMemoryAttestationSigner(schnorr.utils.randomSecretKey());
  }

  async sign(digest: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== 32) throw new Error('attestation digest must be 32 bytes');
    return schnorr.sign(digest, this.#secret);
  }
}
