/** Content-addressed blob store: the key is the lowercase hex SHA-256 of the bytes. */
export interface ContentStore {
  /** Stores the bytes and returns their sha256 hex. Idempotent. */
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
}
