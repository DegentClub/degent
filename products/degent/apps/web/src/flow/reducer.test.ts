import { describe, expect, it } from 'vitest';
import type { Order } from '@bsh/degent-mint-sdk';
import { canEnter, flowReducer } from './reducer';
import { initialState, type Artwork, type FlowState } from './state';
import { demoConfig } from '../services/fakes';
import type { WalletSession } from '../services/types';
import type { RecoveryBundle } from '../lib/recovery';

const config = demoConfig('mainnet');
const wallet = (paymentType: WalletSession['payment']['addressType'] = 'p2wpkh'): WalletSession => ({
  id: 'unisat',
  name: 'UniSat',
  network: 'mainnet',
  ordinals: { address: 'bc1pordinals', publicKey: '00', addressType: 'p2tr' },
  payment: { address: paymentType === 'p2pkh' ? '1Legacy' : 'bc1qpay', publicKey: '02', addressType: paymentType },
  signPsbt: async () => ({ psbtBase64: '' }),
  signMessage: async () => 'AA==',
  disconnect: async () => undefined,
});
const artwork: Artwork = {
  fileName: 'a.webp',
  bytes: new Uint8Array([1]),
  contentType: 'image/webp',
  size: 250_000,
  width: 1000,
  height: 1000,
  sha256: 'ab'.repeat(32),
  origin: 'original',
};
const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1',
  network: 'mainnet',
  status: 'approved',
  tier: 'standard',
  contentType: 'image/webp',
  contentLength: 250_000,
  contentSha256: 'ab'.repeat(32),
  recipientAddress: 'bc1pordinals',
  revealPubkey: 'cd'.repeat(32),
  quote: {
    tier: 'standard',
    lane: 'standard',
    feeRate: 4,
    revealWeight: 251_000,
    revealVsize: 62_750,
    revealFeeSats: 251_000,
    postageSats: 546,
    serviceFeeSats: 0,
    commitValueSats: 251_546,
    totalSats: 251_546,
    commitAddress: 'bc1pcommit',
    binding: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    queuePosition: null,
    etaMinutes: 10,
  },
  review: { approved: true, reasons: [], checks: [] },
  commitOutpoint: null,
  revealTxid: null,
  inscriptionId: null,
  rescued: false,
  serviceFeeAddress: null,
  queue: null,
  approval: null,
  degentNumber: null,
  timeline: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

function run(s: FlowState, ...actions: Parameters<typeof flowReducer>[1][]): FlowState {
  return actions.reduce(flowReducer, s);
}

describe('flow reducer', () => {
  it('starts on welcome and cannot connect before the config is loaded', () => {
    const s0 = initialState();
    expect(s0.step).toBe('welcome');
    expect(run(s0, { type: 'GO', step: 'connect' }).step).toBe('welcome');
    const s1 = run(s0, { type: 'CONFIG_LOADED', config }, { type: 'GO', step: 'connect' });
    expect(s1.step).toBe('connect');
  });

  it('walks the happy path with every guard satisfied in order', () => {
    let s = run(initialState(), { type: 'CONFIG_LOADED', config }, { type: 'GO', step: 'connect' });
    expect(run(s, { type: 'GO', step: 'create' }).step).toBe('connect'); // no wallet yet
    s = run(s, { type: 'WALLET_CONNECTED', wallet: wallet() }, { type: 'GO', step: 'create' });
    expect(s.step).toBe('create');
    expect(run(s, { type: 'GO', step: 'validate' }).step).toBe('create'); // no artwork
    s = run(s, { type: 'ARTWORK_READY', artwork }, { type: 'GO', step: 'validate' });
    expect(s.step).toBe('validate');
    expect(run(s, { type: 'GO', step: 'quote' }).step).toBe('validate'); // not reviewed
    s = run(s, { type: 'ORDER_UPDATED', order: order() }, { type: 'GO', step: 'quote' });
    expect(s.step).toBe('quote');
    expect(s.feeRate).toBe(4);
    expect(run(s, { type: 'GO', step: 'pay' }).step).toBe('quote'); // commit unverified
    s = run(s, { type: 'COMMIT_CHECKED', localAddress: 'bc1pcommit', match: true }, { type: 'GO', step: 'pay' });
    expect(s.step).toBe('pay');
  });

  it('blocks Pay on a commit-address mismatch or an expired quote', () => {
    const base = run(
      initialState(),
      { type: 'CONFIG_LOADED', config },
      { type: 'WALLET_CONNECTED', wallet: wallet() },
      { type: 'ARTWORK_READY', artwork },
      { type: 'ORDER_UPDATED', order: order() },
      { type: 'GO', step: 'quote' },
    );
    expect(run(base, { type: 'COMMIT_CHECKED', localAddress: 'bc1pother', match: false }, { type: 'GO', step: 'pay' }).step).toBe('quote');
    expect(
      run(base, { type: 'COMMIT_CHECKED', localAddress: 'x', match: true }, { type: 'QUOTE_EXPIRED' }, { type: 'GO', step: 'pay' }).step,
    ).toBe('quote');
  });

  it('refuses rejected orders and legacy payment wallets', () => {
    const s = run(
      initialState(),
      { type: 'CONFIG_LOADED', config },
      { type: 'WALLET_CONNECTED', wallet: wallet() },
      { type: 'ARTWORK_READY', artwork },
      { type: 'ORDER_UPDATED', order: order({ status: 'rejected', review: { approved: false, reasons: ['no bowtie'], checks: [] } }) },
    );
    expect(canEnter(s, 'quote')).toBe(false);
    const legacy = run(initialState(), { type: 'CONFIG_LOADED', config }, { type: 'WALLET_CONNECTED', wallet: wallet('p2pkh') });
    expect(canEnter(legacy, 'create')).toBe(false);
  });

  it('clears the order (and its verification) when the art or tier changes', () => {
    const s = run(
      initialState(),
      { type: 'CONFIG_LOADED', config },
      { type: 'WALLET_CONNECTED', wallet: wallet() },
      { type: 'ARTWORK_READY', artwork },
      { type: 'ORDER_UPDATED', order: order() },
      { type: 'COMMIT_CHECKED', localAddress: 'bc1pcommit', match: true },
    );
    const t = flowReducer(s, { type: 'TIER_SELECTED', tier: 'block' });
    expect(t.order).toBeNull();
    expect(t.commitCheck).toBe('unchecked');
    const a = flowReducer(s, { type: 'ARTWORK_READY', artwork: { ...artwork, size: 260_000 } });
    expect(a.order).toBeNull();
  });

  it('clamps fee rates to the collection minimum', () => {
    const s = run(initialState(), { type: 'CONFIG_LOADED', config: { ...config, minFeeRate: 2 } });
    expect(flowReducer(s, { type: 'FEE_RATE_SET', feeRate: 0.5 }).feeRate).toBe(2);
    expect(flowReducer(s, { type: 'FEE_RATE_SET', feeRate: Number.NaN }).feeRate).toBe(2);
    expect(flowReducer(s, { type: 'FEE_RATE_SET', feeRate: 7.5 }).feeRate).toBe(7.5);
  });

  it('pay phases: recovery → broadcast moves to Track, and Back is locked once money may move', () => {
    let s = run(
      initialState(),
      { type: 'CONFIG_LOADED', config },
      { type: 'WALLET_CONNECTED', wallet: wallet() },
      { type: 'ARTWORK_READY', artwork },
      { type: 'ORDER_UPDATED', order: order() },
      { type: 'COMMIT_CHECKED', localAddress: 'bc1pcommit', match: true },
      { type: 'GO', step: 'pay' },
      { type: 'PAY_PHASE', phase: 'submitting-reveal' },
    );
    expect(flowReducer(s, { type: 'BACK' }).step).toBe('pay');
    const bundle = { orderId: 'o1', commitTxid: 'ff'.repeat(32) } as RecoveryBundle;
    s = run(s, { type: 'RECOVERY_SAVED', bundle, savedLocally: true });
    expect(s.pay.phase).toBe('recovery-saved');
    expect(s.recovery).toBe(bundle);
    s = run(s, { type: 'FUNDING_BROADCAST', txid: 'ff'.repeat(32) });
    expect(s.step).toBe('track');
    expect(flowReducer(s, { type: 'BACK' }).step).toBe('track');
  });

  it('a payment failure is recoverable and keeps the recovery bundle', () => {
    const bundle = { orderId: 'o1', commitTxid: 'aa' } as RecoveryBundle;
    const s = run(initialState(), { type: 'RECOVERY_SAVED', bundle, savedLocally: true }, { type: 'PAY_FAILED', error: 'User rejected' });
    expect(s.pay.phase).toBe('error');
    expect(s.pay.error).toBe('User rejected');
    expect(s.recovery).toBe(bundle);
  });

  it('resume jumps straight to Track; dismiss forgets the offer', () => {
    const bundle = { orderId: 'o9', commitTxid: 'bb' } as RecoveryBundle;
    const s = initialState(bundle);
    expect(s.resumeOffer).toBe(bundle);
    const r = flowReducer(s, { type: 'RESUME', bundle });
    expect(r.step).toBe('track');
    expect(r.recovery).toBe(bundle);
    expect(r.resumeOffer).toBeNull();
    expect(flowReducer(s, { type: 'DISMISS_RESUME' }).resumeOffer).toBeNull();
  });

  it('RESET keeps config, fees and wallet but drops the order', () => {
    const s = run(
      initialState(),
      { type: 'CONFIG_LOADED', config },
      { type: 'WALLET_CONNECTED', wallet: wallet() },
      { type: 'ARTWORK_READY', artwork },
      { type: 'RESET' },
    );
    expect(s.step).toBe('welcome');
    expect(s.config).toBe(config);
    expect(s.wallet).not.toBeNull();
    expect(s.artwork).toBeNull();
  });
});
