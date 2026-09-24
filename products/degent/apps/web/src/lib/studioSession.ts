/**
 * Artist Studio session (ADR-0007 §2): the bearer JWT from `POST /v1/auth/verify`, kept in memory
 * and mirrored to sessionStorage (per tab; gone when the tab closes) so a reload does not ask for
 * a new signature. Every storage access is wrapped: private windows and blocked storage must not
 * break sign-in.
 */
import type { KeyValueStore } from './recovery';
import { classifyAddress } from './funding';

export const STUDIO_SESSION_KEY = 'degent.club/studio/session/v1';

export interface StudioSession {
  token: string;
  /** The signed-in address: the artist's identity and the session `sub`. */
  address: string;
  expiresAt: string;
  method: 'bip322-simple' | 'legacy';
}

export function browserSessionStore(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function isStudioSession(v: unknown): v is StudioSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<StudioSession>;
  return (
    typeof s.token === 'string' &&
    s.token.length > 0 &&
    typeof s.address === 'string' &&
    typeof s.expiresAt === 'string' &&
    (s.method === 'bip322-simple' || s.method === 'legacy')
  );
}

export function isExpired(s: StudioSession, now = Date.now()): boolean {
  const t = Date.parse(s.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

export function loadStudioSession(store: KeyValueStore | null, now = Date.now()): StudioSession | null {
  if (!store) return null;
  try {
    const raw = store.getItem(STUDIO_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStudioSession(parsed) || isExpired(parsed, now)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStudioSession(s: StudioSession, store: KeyValueStore | null): boolean {
  if (!store) return false;
  try {
    store.setItem(STUDIO_SESSION_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export function clearStudioSession(store: KeyValueStore | null): void {
  try {
    store?.removeItem(STUDIO_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** The fixed text a payout address signs (contract `payoutMessageTemplate`; ADR-0007 §3). */
export const PAYOUT_MESSAGE_TEMPLATE = 'degent.club payout address <address> for <sessionSub>';

export function payoutMessage(address: string, sessionSub: string, template = PAYOUT_MESSAGE_TEMPLATE): string {
  return template.replace('<address>', address).replace('<sessionSub>', sessionSub);
}

export type PayoutKind = 'p2wpkh' | 'p2tr' | 'legacy' | 'unknown';

/** Only P2WPKH and P2TR can produce BIP-322 simple signatures here; P2PKH and P2SH are refused. */
export function payoutAddressKind(address: string): PayoutKind {
  const t = classifyAddress(address);
  if (t === 'p2tr' || t === 'p2wpkh') return t;
  if (t === 'p2pkh' || t === 'p2sh-p2wpkh') return 'legacy';
  return 'unknown';
}

export class LegacyPayoutError extends Error {
  constructor(address: string) {
    super(
      `${address} is a legacy address (1…, 3…, m…, n… or 2…). The studio only pays royalties to Native SegWit (bc1q…) ` +
        'or Taproot (bc1p…) addresses: they can sign the BIP-322 proof that you control the address, and they keep the ' +
        'minter’s funding transaction small. Pick a SegWit or Taproot account in your wallet and try again.',
    );
    this.name = 'LegacyPayoutError';
  }
}
