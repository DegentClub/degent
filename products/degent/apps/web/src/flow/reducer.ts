/**
 * The mint wizard as a pure state machine. Every step has an entry guard (`canEnter`) so the UI
 * cannot skip review, commit-address verification, or the recovery save.
 */
import type { CollectionConfig, MintMode, Order, Tier } from '@bsh/degent-mint-sdk';
import type { FeeSnapshot, QueueSnapshot, WalletSession } from '../services/types';
import type { RecoveryBundle } from '../lib/recovery';
import { isLegacy, type FundingPsbt } from '../lib/funding';
import { initialPay, initialState, STEPS, type Artwork, type FlowState, type NotifyPref, type PayPhase, type Step } from './state';

export type FlowAction =
  | { type: 'CONFIG_LOADED'; config: CollectionConfig & { mode?: MintMode } }
  | { type: 'SNAPSHOT_LOADED'; fees: FeeSnapshot | null; queue: QueueSnapshot | null }
  | { type: 'GO'; step: Step }
  | { type: 'BACK' }
  | { type: 'WALLET_CONNECTED'; wallet: WalletSession }
  | { type: 'WALLET_DISCONNECTED' }
  | { type: 'TIER_SELECTED'; tier: Tier }
  | { type: 'ARTWORK_READY'; artwork: Artwork }
  | { type: 'ARTWORK_CLEARED' }
  | { type: 'BRIEF_TOGGLED'; id: string; checked: boolean }
  | { type: 'ORDER_UPDATED'; order: Order }
  | { type: 'FEE_RATE_SET'; feeRate: number }
  | { type: 'COMMIT_CHECKED'; localAddress: string; match: boolean }
  | { type: 'QUOTE_EXPIRED' }
  | { type: 'PAY_PHASE'; phase: PayPhase }
  | { type: 'FUNDING_BUILT'; funding: FundingPsbt }
  | { type: 'RECOVERY_SAVED'; bundle: RecoveryBundle; savedLocally: boolean }
  | { type: 'FUNDING_BROADCAST'; txid: string }
  | { type: 'PAY_FAILED'; error: string }
  | { type: 'RESUME'; bundle: RecoveryBundle }
  | { type: 'DISMISS_RESUME' }
  | { type: 'NOTIFY_PREF_SET'; pref: NotifyPref | null }
  | { type: 'ERROR'; error: string | null }
  | { type: 'RESET' };

export function quoteReady(s: FlowState): boolean {
  return !!s.order && !!s.order.review?.approved && !!s.order.quote && s.order.status !== 'rejected';
}

/** Entry guard for each step. */
export function canEnter(s: FlowState, step: Step): boolean {
  switch (step) {
    case 'welcome':
      return true;
    case 'connect':
      return s.config !== null;
    case 'create':
      return s.config !== null && s.wallet !== null && !isLegacy(s.wallet.payment);
    case 'validate':
      return canEnter(s, 'create') && s.artwork !== null;
    case 'quote':
      return quoteReady(s);
    case 'pay':
      return quoteReady(s) && s.commitCheck === 'match' && !s.quoteExpired;
    case 'track':
      return s.recovery !== null || (s.order !== null && s.pay.phase === 'broadcast');
  }
}

function clearOrder(s: FlowState): FlowState {
  return { ...s, order: null, commitCheck: 'unchecked', localCommitAddress: null, quoteExpired: false, pay: initialPay };
}

export function flowReducer(s: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case 'CONFIG_LOADED':
      return { ...s, config: a.config, mintMode: a.config.mode ?? 'full' };
    case 'SNAPSHOT_LOADED':
      return { ...s, fees: a.fees ?? s.fees, queue: a.queue ?? s.queue };
    case 'GO':
      return canEnter(s, a.step) ? { ...s, step: a.step, error: null } : s;
    case 'BACK': {
      // No going back once money may have moved.
      if (s.step === 'track' || (s.step === 'pay' && s.pay.phase !== 'idle' && s.pay.phase !== 'error')) return s;
      const i = STEPS.indexOf(s.step);
      const prev = STEPS[Math.max(0, i - 1)]!;
      return { ...s, step: prev, error: null };
    }
    case 'WALLET_CONNECTED':
      return { ...clearOrder(s), wallet: a.wallet, error: null };
    case 'WALLET_DISCONNECTED': {
      const next = { ...clearOrder(s), wallet: null };
      return s.step === 'track' ? { ...next, order: s.order, recovery: s.recovery, pay: s.pay } : { ...next, step: s.step === 'welcome' ? 'welcome' : 'connect' };
    }
    case 'TIER_SELECTED':
      return s.tier === a.tier ? s : { ...clearOrder(s), tier: a.tier };
    case 'ARTWORK_READY':
      return { ...clearOrder(s), artwork: a.artwork };
    case 'ARTWORK_CLEARED':
      return { ...clearOrder(s), artwork: null };
    case 'BRIEF_TOGGLED':
      return { ...s, briefAck: { ...s.briefAck, [a.id]: a.checked } };
    case 'ORDER_UPDATED': {
      const newOrder = s.order?.id !== a.order.id;
      const base = newOrder ? { ...s, commitCheck: 'unchecked' as const, localCommitAddress: null, quoteExpired: false } : s;
      const feeRate = a.order.quote?.feeRate ?? base.feeRate;
      return { ...base, order: a.order, feeRate };
    }
    case 'FEE_RATE_SET': {
      const min = s.config?.minFeeRate ?? 1;
      const rate = Number.isFinite(a.feeRate) ? Math.max(min, a.feeRate) : min;
      return { ...s, feeRate: rate };
    }
    case 'COMMIT_CHECKED':
      return { ...s, localCommitAddress: a.localAddress, commitCheck: a.match ? 'match' : 'mismatch' };
    case 'QUOTE_EXPIRED':
      return { ...s, quoteExpired: true, step: s.step === 'pay' && s.pay.phase === 'idle' ? 'quote' : s.step };
    case 'PAY_PHASE':
      return { ...s, pay: { ...s.pay, phase: a.phase, error: a.phase === 'error' ? s.pay.error : null } };
    case 'FUNDING_BUILT':
      return { ...s, pay: { ...s.pay, funding: a.funding } };
    case 'RECOVERY_SAVED':
      return {
        ...s,
        recovery: a.bundle,
        pay: { ...s.pay, phase: 'recovery-saved', recoverySavedLocally: a.savedLocally, commitTxid: a.bundle.commitTxid },
      };
    case 'FUNDING_BROADCAST':
      return { ...s, pay: { ...s.pay, phase: 'broadcast', commitTxid: a.txid, error: null }, step: 'track' };
    case 'PAY_FAILED':
      return { ...s, pay: { ...s.pay, phase: 'error', error: a.error } };
    case 'RESUME':
      return { ...s, recovery: a.bundle, resumeOffer: null, step: 'track', order: null };
    case 'DISMISS_RESUME':
      return { ...s, resumeOffer: null };
    case 'NOTIFY_PREF_SET':
      return { ...s, notifyPref: a.pref };
    case 'ERROR':
      return { ...s, error: a.error };
    case 'RESET':
      return { ...initialState(null), config: s.config, fees: s.fees, queue: s.queue, wallet: s.wallet };
  }
}
