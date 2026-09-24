/**
 * Local recovery bundle (ADR-0002 §2, ADR-0005). Saved BEFORE the wallet is asked to sign the funding
 * transaction, so the user can always re-sign the parent-less rescue [commit] -> [child] even if this site or
 * the service disappears. It holds the one-time reveal key K_e ENCRYPTED with the user's recovery passphrase
 * (lib/keyCrypto), every parameter of the rescue except the artwork bytes (identified by their SHA-256), and the
 * order's bearer token. It must stay private; the passphrase must never be stored next to it.
 */
import type { Network } from '@bsh/degent-mint-sdk';
import type { EncryptedRevealKey } from './keyCrypto';

export const RECOVERY_KEY = 'degent.club/recovery/v2';

export interface RecoveryBundle {
  kind: 'degent.club/recovery';
  version: 2;
  orderId: string;
  network: Network;
  mintApiUrl: string;
  savedAt: string;
  commitTxid: string;
  commitVout: number;
  commitValueSats: number;
  recipientAddress: string;
  postageSats: number;
  /** Quoted sat/vB; the rescue (lighter than the parent reveal) pays at least this. */
  feeRate: number;
  contentType: string;
  contentSha256: string;
  /** Parent id in the envelope (tag 3): part of the commit address, so the rescue must repeat it. */
  parentInscriptionId: string | null;
  revealPubkey: string;
  /** K_e, AES-256-GCM under PBKDF2-SHA256(recovery passphrase). */
  revealKey: EncryptedRevealKey;
  /** Bearer token for this order's API calls (rescue parameters). Keep private. */
  orderToken: string;
  note: string;
  warning: string;
}

export const RECOVERY_WARNING =
  'Keep this bundle private and never store your recovery passphrase with it. Together they can spend your ' +
  'commit (the reveal fee you paid) and decide where the inscription goes. The bundle alone cannot.';

export const RECOVERY_NOTE =
  'Self-rescue (ADR-0005): if the mint cannot deliver, decrypt revealKey with your recovery passphrase and ' +
  're-sign [commit] -> [recipientAddress] with @bsh/inscription buildResignedRescue (no parent link). You also ' +
  'need the exact artwork bytes (contentSha256); the mint returns them with the rescue parameters while it is up.';

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
    b.version === 2 &&
    typeof b.orderId === 'string' &&
    typeof b.orderToken === 'string' &&
    typeof b.commitTxid === 'string' &&
    typeof b.revealPubkey === 'string' &&
    typeof b.revealKey === 'object' &&
    b.revealKey !== null &&
    typeof b.revealKey.ciphertext === 'string'
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
