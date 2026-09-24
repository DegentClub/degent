/**
 * Local recovery bundle (ADR-0002 §2 step 5, ADR-0005 §2). Saved BEFORE the wallet is asked to sign
 * the funding transaction, so the user can always rebuild the parent-less rescue reveal even if
 * this site or the service disappears.
 *
 * Since ADR-0005 the reveal is signed SIGHASH_ALL|ANYONECANPAY, which means the stored half-signed
 * PSBT cannot be broadcast without the parent. Self-rescue is therefore a FRESH transaction the
 * user signs with the ephemeral key K_e, so the bundle carries K_e (hex) plus everything needed to
 * rebuild the exact same envelope: the content bytes, content type, parent id, commit outpoint and
 * value, recipient and postage. K_e can spend exactly one thing: the user's own commit output, and
 * only through the inscription tapscript that pays the recipient in this bundle. It must still be
 * kept private: with it (and the order token) someone could rescue early and forfeit the parent link.
 */
import type { Network } from '@bsh/degent-mint-sdk';

export const RECOVERY_KEY = 'degent.club/recovery/v2';
/** v1 (ADR-0002, 0x83) bundles carried a broadcastable PSBT and no key; they are not loaded. */
export const LEGACY_RECOVERY_KEY = 'degent.club/recovery/v1';

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
  contentType: string;
  contentSha256: string;
  /** The exact inscribed bytes, base64: the rescue must rebuild the same tapscript. */
  contentBase64: string;
  /** Envelope parent tag (tag 3) the commit was built with; null when the collection has none. */
  parentInscriptionId: string | null;
  /** What output 0 of the parent-linked reveal was signed to (informational). */
  collectionAddress: string;
  parentValueSats: number;
  /** Ephemeral reveal key K_e, 32-byte hex. Controls only the commit output above. KEEP PRIVATE. */
  revealPrivkey: string;
  revealPubkey: string;
  /** Bearer token for this order's mutating API calls (rescue inputs). Keep private. */
  orderToken: string;
  note: string;
  warning: string;
}

export const RECOVERY_WARNING =
  'Keep this bundle private. It holds your one-time reveal key and the order token. The key controls ' +
  'only your own commit output, and only into your ordinals address above; it cannot touch anything ' +
  'else in your wallet. Anyone with the bundle could still trigger the rescue early and forfeit the ' +
  'parent link. It cannot redirect your Degent or your funds.';

export const RECOVERY_NOTE =
  'Degent self-rescue kit (ADR-0005). If the mint service is unavailable, sign a fresh transaction ' +
  '[commit] -> [your ordinals address] with the revealPrivkey below (@bsh/inscription.buildResignedRescue, ' +
  'or the Rescue button on degent.club). It inscribes exactly the content bytes in this bundle, without ' +
  'the parent link. The key can pay nobody but the recipient address above.';

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

const HEX32 = /^[0-9a-f]{64}$/;

export function isRecoveryBundle(v: unknown): v is RecoveryBundle {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<RecoveryBundle>;
  return (
    b.kind === 'degent.club/recovery' &&
    b.version === 2 &&
    typeof b.orderId === 'string' &&
    typeof b.orderToken === 'string' &&
    typeof b.commitTxid === 'string' &&
    HEX32.test(b.commitTxid) &&
    typeof b.commitVout === 'number' &&
    typeof b.commitValueSats === 'number' &&
    typeof b.recipientAddress === 'string' &&
    typeof b.postageSats === 'number' &&
    typeof b.contentType === 'string' &&
    typeof b.contentSha256 === 'string' &&
    HEX32.test(b.contentSha256) &&
    typeof b.contentBase64 === 'string' &&
    (b.parentInscriptionId === null || typeof b.parentInscriptionId === 'string') &&
    typeof b.revealPrivkey === 'string' &&
    HEX32.test(b.revealPrivkey) &&
    typeof b.revealPubkey === 'string' &&
    HEX32.test(b.revealPubkey)
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
    return parseRecovery(raw);
  } catch {
    return null;
  }
}

/** Parse a pasted bundle; null when it is not a v2 bundle. */
export function parseRecovery(json: string): RecoveryBundle | null {
  try {
    const parsed: unknown = JSON.parse(json);
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

// base64 helpers for the content bytes (browser and jsdom: btoa/atob; chunked to avoid call-stack limits)
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
