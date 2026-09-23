/**
 * In-memory holder for the ephemeral reveal key K_e (ADR-0002 §2). Never serialised, never put in
 * React state, never sent anywhere. `discard` zeroes the bytes before dropping the reference.
 */
export interface KeyVault {
  put(orderId: string, privkey: Uint8Array): void;
  get(orderId: string): Uint8Array | null;
  has(orderId: string): boolean;
  discard(orderId: string): void;
  discardAll(): void;
}

export function createKeyVault(): KeyVault {
  const keys = new Map<string, Uint8Array>();
  const wipe = (k: Uint8Array) => k.fill(0);
  return {
    put(orderId, privkey) {
      const prev = keys.get(orderId);
      if (prev) wipe(prev);
      keys.set(orderId, privkey);
    },
    get(orderId) {
      return keys.get(orderId) ?? null;
    },
    has(orderId) {
      return keys.has(orderId);
    },
    discard(orderId) {
      const k = keys.get(orderId);
      if (k) wipe(k);
      keys.delete(orderId);
    },
    discardAll() {
      for (const k of keys.values()) wipe(k);
      keys.clear();
    },
  };
}
