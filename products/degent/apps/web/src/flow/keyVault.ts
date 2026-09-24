/**
 * In-memory holder for the ephemeral reveal key K_e (ADR-0002 §2) and the order's bearer token.
 * Neither is put in React state or logged. The plaintext K_e is never serialised or sent anywhere;
 * `discard` zeroes it before dropping the reference, once preparePayment has put it into the recovery
 * bundle ENCRYPTED with the user's passphrase (ADR-0005: the self-rescue re-signs with it). The token
 * is persisted only inside the recovery bundle.
 */
export interface KeyVault {
  putToken(orderId: string, token: string): void;
  token(orderId: string): string | null;
  put(orderId: string, privkey: Uint8Array): void;
  get(orderId: string): Uint8Array | null;
  has(orderId: string): boolean;
  discard(orderId: string): void;
  discardAll(): void;
}

export function createKeyVault(): KeyVault {
  const keys = new Map<string, Uint8Array>();
  const tokens = new Map<string, string>();
  const wipe = (k: Uint8Array) => k.fill(0);
  return {
    putToken(orderId, token) {
      tokens.set(orderId, token);
    },
    token(orderId) {
      return tokens.get(orderId) ?? null;
    },
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
