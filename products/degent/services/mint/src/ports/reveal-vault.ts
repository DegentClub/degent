/**
 * Storage for half-signed reveal PSBTs, kept apart from order rows and encrypted at rest.
 * Treat values as secrets: never log them, never put them in events or API responses.
 */
export interface RevealVault {
  put(orderId: string, psbtBase64: string): Promise<void>;
  get(orderId: string): Promise<string | null>;
  delete(orderId: string): Promise<void>;
}

/** Raw ciphertext persistence underneath the encrypting vault. */
export interface SecretBlobStore {
  putBlob(key: string, blob: Uint8Array): Promise<void>;
  getBlob(key: string): Promise<Uint8Array | null>;
  deleteBlob(key: string): Promise<void>;
}
