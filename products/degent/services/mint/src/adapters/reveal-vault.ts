/**
 * AES-256-GCM encrypting RevealVault (node:crypto). Blob layout: version(1)=0x01 | iv(12) | tag(16)
 * | ciphertext. The order id is bound as additional authenticated data, so a ciphertext copied onto
 * another order fails to decrypt. The key comes from REVEAL_ENCRYPTION_KEY (32-byte hex).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { RevealVault, SecretBlobStore } from '../ports/reveal-vault.js';

const VERSION = 0x01;

export class EncryptedRevealVault implements RevealVault {
  private readonly key: Buffer;
  constructor(private readonly blobs: SecretBlobStore, keyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('REVEAL_ENCRYPTION_KEY must be 32 bytes of hex');
    this.key = Buffer.from(keyHex, 'hex');
  }

  async put(orderId: string, psbtBase64: string): Promise<void> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`degent-mint/reveal/${orderId}`));
    const ct = Buffer.concat([c.update(psbtBase64, 'utf8'), c.final()]);
    const blob = Buffer.concat([Buffer.of(VERSION), iv, c.getAuthTag(), ct]);
    await this.blobs.putBlob(orderId, new Uint8Array(blob));
  }

  async get(orderId: string): Promise<string | null> {
    const blob = await this.blobs.getBlob(orderId);
    if (!blob) return null;
    const b = Buffer.from(blob);
    if (b.length < 29 || b[0] !== VERSION) throw new Error('reveal vault: unknown blob format');
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(1, 13));
    d.setAAD(Buffer.from(`degent-mint/reveal/${orderId}`));
    d.setAuthTag(b.subarray(13, 29));
    return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8');
  }

  async delete(orderId: string): Promise<void> {
    await this.blobs.deleteBlob(orderId);
  }
}

export class MemorySecretBlobStore implements SecretBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async putBlob(key: string, blob: Uint8Array): Promise<void> {
    this.blobs.set(key, Uint8Array.from(blob));
  }
  async getBlob(key: string): Promise<Uint8Array | null> {
    const b = this.blobs.get(key);
    return b ? Uint8Array.from(b) : null;
  }
  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** Fixed dev key, accepted ONLY when NETWORK=regtest (config.ts enforces this). */
export const REGTEST_DEV_REVEAL_KEY = '6465676e742d6d696e742d726567746573742d6f6e6c792d6465762d6b657921';
