/**
 * Pure state machine for one mint order.
 *
 *   idle → fileReady → quoting → quoted → paying → submitted → confirmed
 *                        │          │        │
 *                        └──────────┴────────┴──→ failed  (retry → fileReady / quoted)
 *
 * Invariants enforced by the reducer (and covered by tests):
 *  - a quote is only usable when its key matches the *current* inputs;
 *  - `PAY_STARTED` is accepted only when `canMint()` is true;
 *  - `submitted` / `confirmed` are terminal for the order: input changes are
 *    ignored and a fresh order requires an explicit `RESET`.
 *
 * The reducer has no side effects. Fetching quotes, hashing files and talking
 * to wallets happens in the component layer, which reports back via actions.
 */
import { FEE_DEFAULT, FEE_WARN, isFeeRateInRange } from './fees';

export type Phase =
  | 'idle'
  | 'fileReady'
  | 'quoting'
  | 'quoted'
  | 'paying'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export interface WalletInfo {
  walletId: string;
  walletName: string;
  address: string;
  publicKey?: string;
  network: string;
}

export interface FileInfo {
  hash: string;
  size: number;
  name: string;
  type: string;
  /** Whether the file passes the operator's size/type rules. */
  valid: boolean;
}

export interface QuoteKey {
  feeRate: number;
  fileHash: string;
  recipient: string;
}

export interface Quote {
  key: QuoteKey;
  paymentAddress: string;
  amountSats: number;
  inscriptionId: string;
}

export interface SubmittedOrder {
  txid: string;
  paidAt: number;
}

export interface MintState {
  phase: Phase;
  wallet: WalletInfo | null;
  /** Taproot address that will receive the inscription. */
  recipient: string | null;
  file: FileInfo | null;
  feeRate: number;
  highFeeConfirmed: boolean;
  quote: Quote | null;
  /** Id of the quote request currently in flight; results with other ids are ignored. */
  quoteRequestId: number | null;
  /** Bumped on RETRY so the effect layer sees a new target after a failure. */
  attempt: number;
  order: SubmittedOrder | null;
  error: string | null;
}

export type MintAction =
  | { type: 'WALLET_CONNECTED'; wallet: WalletInfo }
  | { type: 'WALLET_DISCONNECTED' }
  | { type: 'RECIPIENT_SET'; recipient: string | null }
  | { type: 'FILE_SET'; file: FileInfo }
  | { type: 'FILE_CLEARED' }
  | { type: 'FEE_RATE_SET'; feeRate: number }
  | { type: 'HIGH_FEE_CONFIRMED' }
  | { type: 'QUOTE_STARTED'; requestId: number; key: QuoteKey }
  | { type: 'QUOTE_SUCCEEDED'; requestId: number; quote: Quote }
  | { type: 'QUOTE_FAILED'; requestId: number; error: string }
  | { type: 'PAY_STARTED' }
  | { type: 'PAY_SUCCEEDED'; txid: string; paidAt?: number }
  | { type: 'PAY_FAILED'; error: string }
  | { type: 'PAYMENT_CONFIRMED' }
  | { type: 'RETRY' }
  | { type: 'RESET' };

export const initialMintState: MintState = {
  phase: 'idle',
  wallet: null,
  recipient: null,
  file: null,
  feeRate: FEE_DEFAULT,
  highFeeConfirmed: false,
  quote: null,
  quoteRequestId: null,
  attempt: 0,
  order: null,
  error: null,
};

const TERMINAL: ReadonlySet<Phase> = new Set<Phase>(['paying', 'submitted', 'confirmed']);

export function isOrderLocked(state: MintState): boolean {
  return TERMINAL.has(state.phase);
}

export function keysEqual(a: QuoteKey | null | undefined, b: QuoteKey | null | undefined): boolean {
  if (!a || !b) return false;
  return a.feeRate === b.feeRate && a.fileHash === b.fileHash && a.recipient === b.recipient;
}

/** The key a quote must carry to be valid for the current inputs, or null when inputs are incomplete. */
export function currentQuoteKey(state: MintState): QuoteKey | null {
  if (!state.file || !state.file.valid || !state.recipient) return null;
  if (!isFeeRateInRange(state.feeRate)) return null;
  return { feeRate: state.feeRate, fileHash: state.file.hash, recipient: state.recipient };
}

export function hasFreshQuote(state: MintState): boolean {
  return !!state.quote && keysEqual(state.quote.key, currentQuoteKey(state));
}

export function requiresHighFeeConfirmation(state: MintState): boolean {
  return state.feeRate > FEE_WARN && !state.highFeeConfirmed;
}

/** True only when paying right now would spend exactly what the user is looking at. */
export function canMint(state: MintState): boolean {
  return (
    state.phase === 'quoted' &&
    !!state.wallet &&
    hasFreshQuote(state) &&
    !requiresHighFeeConfirmation(state)
  );
}

/**
 * True when a quote for the current inputs is wanted (either not yet
 * requested, or currently in flight). The machine never auto-retries after a
 * failure: the user must hit RETRY or change an input.
 */
export function shouldQuote(state: MintState): boolean {
  if (isOrderLocked(state) || state.phase === 'failed') return false;
  if (!state.wallet) return false;
  if (!currentQuoteKey(state)) return false;
  return !hasFreshQuote(state);
}

/** Stable string for the current quote target, handy as an effect dependency. */
export function quoteTargetId(state: MintState): string | null {
  if (!shouldQuote(state)) return null;
  const key = currentQuoteKey(state)!;
  return `${key.feeRate}|${key.fileHash}|${key.recipient}|${state.attempt}`;
}

function phaseAfterInputChange(state: MintState): Phase {
  if (!state.file) return 'idle';
  return hasFreshQuote(state) ? 'quoted' : 'fileReady';
}

export function mintReducer(state: MintState, action: MintAction): MintState {
  switch (action.type) {
    case 'RESET':
      // Keep the wallet session; everything order-specific goes.
      return {
        ...initialMintState,
        wallet: state.wallet,
        recipient: state.recipient,
        feeRate: state.feeRate,
        attempt: state.attempt + 1,
      };

    case 'WALLET_CONNECTED': {
      if (isOrderLocked(state)) return state;
      const next = { ...state, wallet: action.wallet, error: null };
      return { ...next, phase: phaseAfterInputChange(next) };
    }

    case 'WALLET_DISCONNECTED': {
      if (isOrderLocked(state)) return state;
      const next: MintState = {
        ...state,
        wallet: null,
        recipient: null,
        quote: null,
        quoteRequestId: null,
        error: null,
      };
      return { ...next, phase: next.file ? 'fileReady' : 'idle' };
    }

    case 'RECIPIENT_SET': {
      if (isOrderLocked(state)) return state;
      const next = { ...state, recipient: action.recipient, error: null };
      return { ...next, phase: phaseAfterInputChange(next) };
    }

    case 'FILE_SET': {
      if (isOrderLocked(state)) return state;
      const next = { ...state, file: action.file, error: null };
      return { ...next, phase: phaseAfterInputChange(next) };
    }

    case 'FILE_CLEARED': {
      if (isOrderLocked(state)) return state;
      return { ...state, file: null, quote: null, quoteRequestId: null, error: null, phase: 'idle' };
    }

    case 'FEE_RATE_SET': {
      if (isOrderLocked(state)) return state;
      if (action.feeRate === state.feeRate) return state;
      const next = {
        ...state,
        feeRate: action.feeRate,
        highFeeConfirmed: false,
        error: null,
      };
      return { ...next, phase: phaseAfterInputChange(next) };
    }

    case 'HIGH_FEE_CONFIRMED':
      if (isOrderLocked(state)) return state;
      return { ...state, highFeeConfirmed: true };

    case 'QUOTE_STARTED': {
      if (isOrderLocked(state)) return state;
      // Only start a quote for what the inputs currently say.
      if (!keysEqual(action.key, currentQuoteKey(state))) return state;
      return { ...state, phase: 'quoting', quoteRequestId: action.requestId, error: null };
    }

    case 'QUOTE_SUCCEEDED': {
      if (state.phase !== 'quoting' || action.requestId !== state.quoteRequestId) return state;
      // Inputs changed while the request was in flight: the result is stale.
      if (!keysEqual(action.quote.key, currentQuoteKey(state))) {
        return { ...state, phase: 'fileReady', quoteRequestId: null };
      }
      return { ...state, phase: 'quoted', quote: action.quote, quoteRequestId: null, error: null };
    }

    case 'QUOTE_FAILED': {
      if (state.phase !== 'quoting' || action.requestId !== state.quoteRequestId) return state;
      return { ...state, phase: 'failed', quote: null, quoteRequestId: null, error: action.error };
    }

    case 'PAY_STARTED':
      if (!canMint(state)) return state;
      return { ...state, phase: 'paying', error: null };

    case 'PAY_SUCCEEDED':
      if (state.phase !== 'paying') return state;
      return {
        ...state,
        phase: 'submitted',
        order: { txid: action.txid, paidAt: action.paidAt ?? Date.now() },
        error: null,
      };

    case 'PAY_FAILED':
      if (state.phase !== 'paying') return state;
      // The quote is still valid; the user may simply have rejected the wallet prompt.
      return { ...state, phase: 'failed', error: action.error };

    case 'PAYMENT_CONFIRMED':
      if (state.phase !== 'submitted') return state;
      return { ...state, phase: 'confirmed' };

    case 'RETRY': {
      if (state.phase !== 'failed') return state;
      const next = { ...state, error: null, attempt: state.attempt + 1 };
      return { ...next, phase: phaseAfterInputChange(next) };
    }

    default:
      return state;
  }
}

/** Human-readable reason the mint button is disabled, or null when it is enabled. */
export function disabledReason(state: MintState): string | null {
  if (canMint(state)) return null;
  if (!state.wallet) return 'Connect a wallet to continue';
  if (!state.file) return 'Upload an image to continue';
  if (!state.file.valid) return 'Adjust the image until its size is within range';
  if (!state.recipient) return 'Choose a taproot (bc1p) address to receive the inscription';
  if (!isFeeRateInRange(state.feeRate)) return 'Fee rate is out of range';
  if (state.phase === 'quoting') return 'Fetching a quote...';
  if (state.phase === 'failed') return state.error ?? 'Something went wrong';
  if (state.phase === 'paying') return 'Waiting for your wallet...';
  if (state.phase === 'submitted' || state.phase === 'confirmed') return 'Payment already sent for this order';
  if (requiresHighFeeConfirmation(state)) return `Confirm the high fee rate (above ${FEE_WARN} sat/vB)`;
  if (!hasFreshQuote(state)) return 'Waiting for an up-to-date quote...';
  return 'Not ready';
}
