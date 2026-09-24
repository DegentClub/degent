import type { CollectionConfig, MintMode, NotifyChannel, Order, Tier } from '@bsh/degent-mint-sdk';
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
  origin: 'original' | 'reencoded' | 'atelier';
  quality?: number;
  scale?: number;
  /** Set when the Atelier composed the piece: frame width (% of the edge) and placard text. */
  framing?: { framePct: number; placard: string };
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

export type CommitCheck = 'unchecked' | 'match' | 'mismatch';

/** "Notify me" chosen before paying (Welcome): subscribed on Track once the order token exists. Memory only. */
export interface NotifyPref {
  channel: NotifyChannel;
  address: string;
}

export interface FlowState {
  step: Step;
  config: CollectionConfig | null;
  /** The mint's runtime mode from `/v1/config` (null until it answers; then AppConfig.mintMode is the hint). */
  mintMode: MintMode | null;
  fees: FeeSnapshot | null;
  queue: QueueSnapshot | null;
  wallet: WalletSession | null;
  tier: Tier;
  artwork: Artwork | null;
  briefAck: Record<string, boolean>;
  order: Order | null;
  feeRate: number | null;
  commitCheck: CommitCheck;
  localCommitAddress: string | null;
  quoteExpired: boolean;
  pay: PayState;
  recovery: RecoveryBundle | null;
  resumeOffer: RecoveryBundle | null;
  notifyPref: NotifyPref | null;
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
    mintMode: null,
    fees: null,
    queue: null,
    wallet: null,
    tier: 'standard',
    artwork: null,
    briefAck: {},
    order: null,
    feeRate: null,
    commitCheck: 'unchecked',
    localCommitAddress: null,
    quoteExpired: false,
    pay: initialPay,
    recovery: null,
    resumeOffer,
    notifyPref: null,
    error: null,
  };
}
