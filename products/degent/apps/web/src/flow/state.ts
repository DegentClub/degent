import type { Order, ServiceConfig, Tier } from '@bsh/degent-mint-sdk';
import type { FeeSnapshot, QueueSnapshot, WalletSession } from '../services/types';
import type { RecoveryBundle } from '../lib/recovery';
import type { FundingPsbt } from '../lib/funding';

export type Step = 'welcome' | 'connect' | 'create' | 'validate' | 'quote' | 'pay' | 'track';

export const STEPS: readonly Step[] = ['welcome', 'connect', 'create', 'validate', 'quote', 'pay', 'track'];

export const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  connect: 'Connect',
  create: 'Create',
  validate: 'Validate',
  quote: 'Quote',
  pay: 'Pay',
  track: 'Track',
};

/** The exact bytes that will be inscribed, plus facts measured from them. */
export interface Artwork {
  fileName: string;
  bytes: Uint8Array;
  contentType: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
  origin: 'original' | 'reencoded';
  quality?: number;
  scale?: number;
}

export type PayPhase =
  | 'idle'
  | 'fetching-utxos'
  | 'building'
  | 'submitting-reveal'
  | 'recovery-saved'
  | 'awaiting-wallet'
  | 'broadcasting'
  | 'broadcast'
  | 'error';

export interface PayState {
  phase: PayPhase;
  funding: FundingPsbt | null;
  commitTxid: string | null;
  error: string | null;
  recoverySavedLocally: boolean;
}

/**
 * Art handed to the mint from elsewhere on the site (the Atelier or "Bring your own art"). The
 * bytes in `artwork` are exactly the bytes the handoff produced; the mint skips Create and lands on
 * Validate (after Connect when no wallet is connected yet).
 */
export interface HandoffInfo {
  source: 'atelier' | 'upload';
  /** Human label, e.g. the brief or the file name. */
  label: string;
}

export type CommitCheck = 'unchecked' | 'match' | 'mismatch';

export interface FlowState {
  step: Step;
  /** GET /v1/config: rules plus collectionAddress / parentValueSats (needed to sign the reveal). */
  config: ServiceConfig | null;
  fees: FeeSnapshot | null;
  queue: QueueSnapshot | null;
  wallet: WalletSession | null;
  tier: Tier;
  artwork: Artwork | null;
  handoff: HandoffInfo | null;
  briefAck: Record<string, boolean>;
  order: Order | null;
  feeRate: number | null;
  commitCheck: CommitCheck;
  localCommitAddress: string | null;
  quoteExpired: boolean;
  pay: PayState;
  recovery: RecoveryBundle | null;
  resumeOffer: RecoveryBundle | null;
  error: string | null;
}

export const initialPay: PayState = {
  phase: 'idle',
  funding: null,
  commitTxid: null,
  error: null,
  recoverySavedLocally: false,
};

export function initialState(resumeOffer: RecoveryBundle | null = null): FlowState {
  return {
    step: 'welcome',
    config: null,
    fees: null,
    queue: null,
    wallet: null,
    tier: 'standard',
    artwork: null,
    handoff: null,
    briefAck: {},
    order: null,
    feeRate: null,
    commitCheck: 'unchecked',
    localCommitAddress: null,
    quoteExpired: false,
    pay: initialPay,
    recovery: null,
    resumeOffer,
    error: null,
  };
}
