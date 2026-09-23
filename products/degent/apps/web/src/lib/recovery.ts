/**
 * Local recovery bundle (ADR-0002 §2 step 5). Saved BEFORE the wallet is asked to sign the funding
 * transaction, so the user can always rebuild the parent-less rescue reveal even if this site or
 * the service disappears. Contains no private key: the half-signed reveal is only spendable into
 * the user's own ordinals address.
 */
import type { Network } from '@bsh/degent-mint-sdk';

export const RECOVERY_KEY = 'degent.club/recovery/v1';

export interface RecoveryBundle {
  kind: 'degent.club/recovery';
  version: 1;
  orderId: string;
  network: Network;
  mintApiUrl: string;
  savedAt: string;
  commitTxid: string;
  commitVout: number;
  commitValueSats: number;
  recipientAddress: string;
  contentType: string;
  contentSha256: string;
  halfSignedRevealPsbt: string;
  note: string;
}

export const RECOVERY_NOTE =
  'Half-signed Degent reveal (SIGHASH_SINGLE|ANYONECANPAY). If the mint service is unavailable, ' +
  'this PSBT alone can be broadcast as [commit] -> [your ordinals address] ("rescue"), without the ' +
  'parent link. It cannot pay anyone but the recipient address above.';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isRecoveryBundle(v: unknown): v is RecoveryBundle {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<RecoveryBundle>;
  return (
    b.kind === 'degent.club/recovery' &&
    b.version === 1 &&
    typeof b.orderId === 'string' &&
    typeof b.halfSignedRevealPsbt === 'string' &&
    typeof b.commitTxid === 'string'
  );
}

export function saveRecovery(bundle: RecoveryBundle, store: KeyValueStore | null = browserStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(RECOVERY_KEY, JSON.stringify(bundle));
    return store.getItem(RECOVERY_KEY) !== null;
  } catch {
    return false;
  }
}

export function loadRecovery(store: KeyValueStore | null = browserStore()): RecoveryBundle | null {
  if (!store) return null;
  try {
    const raw = store.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecoveryBundle(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRecovery(store: KeyValueStore | null = browserStore()): void {
  try {
    store?.removeItem(RECOVERY_KEY);
  } catch {
    /* ignore */
  }
}

export function recoveryJson(bundle: RecoveryBundle): string {
  return JSON.stringify(bundle, null, 2);
}
