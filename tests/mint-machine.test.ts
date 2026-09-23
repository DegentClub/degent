import { describe, expect, it } from 'vitest';
import {
  canMint,
  currentQuoteKey,
  disabledReason,
  hasFreshQuote,
  initialMintState,
  mintReducer,
  quoteTargetId,
  shouldQuote,
  type FileInfo,
  type MintAction,
  type MintState,
  type Quote,
  type WalletInfo,
} from '@/lib/mint-machine';

const wallet: WalletInfo = {
  walletId: 'unisat',
  walletName: 'UniSat',
  address: 'bc1qsender',
  network: 'mainnet',
};
const recipient = 'bc1precipient';
const file: FileInfo = { hash: 'hash-a', size: 250_000, name: 'a.png', type: 'image/png', valid: true };

function run(actions: MintAction[], from: MintState = initialMintState): MintState {
  return actions.reduce(mintReducer, from);
}

function quoteFor(state: MintState, overrides: Partial<Quote> = {}): Quote {
  const key = currentQuoteKey(state);
  if (!key) throw new Error('inputs incomplete');
  return { key, paymentAddress: 'bc1qpay', amountSats: 12_345, inscriptionId: 'insc-1', ...overrides };
}

function readyState(): MintState {
  return run([
    { type: 'WALLET_CONNECTED', wallet },
    { type: 'RECIPIENT_SET', recipient },
    { type: 'FILE_SET', file },
    { type: 'FEE_RATE_SET', feeRate: 2 },
  ]);
}

function quotedState(): MintState {
  const ready = readyState();
  const key = currentQuoteKey(ready)!;
  return run(
    [
      { type: 'QUOTE_STARTED', requestId: 1, key },
      { type: 'QUOTE_SUCCEEDED', requestId: 1, quote: quoteFor(ready) },
    ],
    ready
  );
}

describe('mint machine: happy path', () => {
  it('walks idle → fileReady → quoting → quoted → paying → submitted → confirmed', () => {
    let s = initialMintState;
    expect(s.phase).toBe('idle');
    s = mintReducer(s, { type: 'WALLET_CONNECTED', wallet });
    expect(s.phase).toBe('idle');
    s = mintReducer(s, { type: 'RECIPIENT_SET', recipient });
    s = mintReducer(s, { type: 'FILE_SET', file });
    expect(s.phase).toBe('fileReady');
    expect(shouldQuote(s)).toBe(true);
    expect(canMint(s)).toBe(false);

    const key = currentQuoteKey(s)!;
    s = mintReducer(s, { type: 'QUOTE_STARTED', requestId: 7, key });
    expect(s.phase).toBe('quoting');
    expect(shouldQuote(s)).toBe(true); // still wanted while in flight, so the effect keeps its request alive
    expect(quoteTargetId(s)).not.toBeNull();

    s = mintReducer(s, { type: 'QUOTE_SUCCEEDED', requestId: 7, quote: quoteFor(s) });
    expect(s.phase).toBe('quoted');
    expect(hasFreshQuote(s)).toBe(true);
    expect(canMint(s)).toBe(true);
    expect(quoteTargetId(s)).toBeNull();

    s = mintReducer(s, { type: 'PAY_STARTED' });
    expect(s.phase).toBe('paying');
    s = mintReducer(s, { type: 'PAY_SUCCEEDED', txid: 'tx1', paidAt: 1 });
    expect(s.phase).toBe('submitted');
    expect(s.order).toEqual({ txid: 'tx1', paidAt: 1 });
    s = mintReducer(s, { type: 'PAYMENT_CONFIRMED' });
    expect(s.phase).toBe('confirmed');
  });
});

describe('mint machine: double payment is impossible', () => {
  it('rejects PAY_STARTED once a payment is in flight or done', () => {
    const paying = mintReducer(quotedState(), { type: 'PAY_STARTED' });
    expect(canMint(paying)).toBe(false);
    expect(mintReducer(paying, { type: 'PAY_STARTED' })).toBe(paying);

    const submitted = mintReducer(paying, { type: 'PAY_SUCCEEDED', txid: 'tx1' });
    expect(canMint(submitted)).toBe(false);
    expect(mintReducer(submitted, { type: 'PAY_STARTED' })).toBe(submitted);
    expect(disabledReason(submitted)).toMatch(/already sent/i);
  });

  it('ignores input changes after submission; only RESET starts a new order', () => {
    const submitted = run([{ type: 'PAY_STARTED' }, { type: 'PAY_SUCCEEDED', txid: 'tx1' }], quotedState());

    const afterFee = mintReducer(submitted, { type: 'FEE_RATE_SET', feeRate: 9 });
    expect(afterFee).toBe(submitted);
    const afterFile = mintReducer(submitted, { type: 'FILE_SET', file: { ...file, hash: 'hash-b' } });
    expect(afterFile).toBe(submitted);
    const afterDisconnect = mintReducer(submitted, { type: 'WALLET_DISCONNECTED' });
    expect(afterDisconnect).toBe(submitted);
    expect(shouldQuote(submitted)).toBe(false);

    const reset = mintReducer(submitted, { type: 'RESET' });
    expect(reset.phase).toBe('idle');
    expect(reset.quote).toBeNull();
    expect(reset.order).toBeNull();
    expect(reset.wallet).toEqual(wallet); // session survives
    expect(reset.feeRate).toBe(2);
  });

  it('a failed payment returns to failed and can be retried with the same fresh quote', () => {
    const failed = run([{ type: 'PAY_STARTED' }, { type: 'PAY_FAILED', error: 'User rejected' }], quotedState());
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('User rejected');
    expect(canMint(failed)).toBe(false);
    const retried = mintReducer(failed, { type: 'RETRY' });
    expect(retried.phase).toBe('quoted');
    expect(canMint(retried)).toBe(true);
  });
});

describe('mint machine: stale quotes are blocked', () => {
  it('changing the fee rate invalidates the quote until a new one arrives', () => {
    const quoted = quotedState();
    const changed = mintReducer(quoted, { type: 'FEE_RATE_SET', feeRate: 3 });
    expect(changed.phase).toBe('fileReady');
    expect(canMint(changed)).toBe(false);
    expect(hasFreshQuote(changed)).toBe(false);
    expect(shouldQuote(changed)).toBe(true);
    expect(mintReducer(changed, { type: 'PAY_STARTED' })).toBe(changed);

    // Going back to the original rate makes the old quote fresh again.
    const back = mintReducer(changed, { type: 'FEE_RATE_SET', feeRate: 2 });
    expect(back.phase).toBe('quoted');
    expect(canMint(back)).toBe(true);
  });

  it('changing the file or recipient invalidates the quote', () => {
    const quoted = quotedState();
    expect(canMint(mintReducer(quoted, { type: 'FILE_SET', file: { ...file, hash: 'hash-b' } }))).toBe(false);
    expect(canMint(mintReducer(quoted, { type: 'RECIPIENT_SET', recipient: 'bc1pother' }))).toBe(false);
    expect(canMint(mintReducer(quoted, { type: 'RECIPIENT_SET', recipient: null }))).toBe(false);
  });

  it('a quote result for inputs that have since changed is discarded', () => {
    const ready = readyState();
    const oldKey = currentQuoteKey(ready)!;
    const quoting = mintReducer(ready, { type: 'QUOTE_STARTED', requestId: 1, key: oldKey });
    const bumped = mintReducer(quoting, { type: 'FEE_RATE_SET', feeRate: 5 });
    const stale = mintReducer(bumped, {
      type: 'QUOTE_SUCCEEDED',
      requestId: 1,
      quote: { key: oldKey, paymentAddress: 'bc1qpay', amountSats: 1, inscriptionId: 'x' },
    });
    expect(stale.phase).not.toBe('quoted');
    expect(canMint(stale)).toBe(false);
  });

  it('results carrying an unknown request id are ignored', () => {
    const ready = readyState();
    const key = currentQuoteKey(ready)!;
    const quoting = mintReducer(ready, { type: 'QUOTE_STARTED', requestId: 2, key });
    const ignored = mintReducer(quoting, { type: 'QUOTE_SUCCEEDED', requestId: 1, quote: quoteFor(quoting) });
    expect(ignored).toBe(quoting);
    const ignoredFail = mintReducer(quoting, { type: 'QUOTE_FAILED', requestId: 1, error: 'boom' });
    expect(ignoredFail).toBe(quoting);
  });

  it('QUOTE_STARTED for a key that does not match the inputs is a no-op', () => {
    const ready = readyState();
    const wrong = mintReducer(ready, {
      type: 'QUOTE_STARTED',
      requestId: 1,
      key: { feeRate: 99, fileHash: 'nope', recipient },
    });
    expect(wrong).toBe(ready);
  });
});

describe('mint machine: guards and edge cases', () => {
  it('does not auto-retry after a quote failure', () => {
    const ready = readyState();
    const key = currentQuoteKey(ready)!;
    const failed = run(
      [
        { type: 'QUOTE_STARTED', requestId: 1, key },
        { type: 'QUOTE_FAILED', requestId: 1, error: 'upstream down' },
      ],
      ready
    );
    expect(failed.phase).toBe('failed');
    expect(shouldQuote(failed)).toBe(false);
    expect(quoteTargetId(failed)).toBeNull();
    const retried = mintReducer(failed, { type: 'RETRY' });
    expect(shouldQuote(retried)).toBe(true);
    expect(quoteTargetId(retried)).not.toBe(quoteTargetId(ready)); // attempt counter changed
  });

  it('requires an explicit confirmation for fee rates above the warning threshold', () => {
    const ready = mintReducer(readyState(), { type: 'FEE_RATE_SET', feeRate: 80 });
    const key = currentQuoteKey(ready)!;
    const quoted = run(
      [
        { type: 'QUOTE_STARTED', requestId: 1, key },
        { type: 'QUOTE_SUCCEEDED', requestId: 1, quote: quoteFor(ready) },
      ],
      ready
    );
    expect(quoted.phase).toBe('quoted');
    expect(canMint(quoted)).toBe(false);
    expect(disabledReason(quoted)).toMatch(/confirm the high fee/i);
    const confirmed = mintReducer(quoted, { type: 'HIGH_FEE_CONFIRMED' });
    expect(canMint(confirmed)).toBe(true);
    // Any fee change drops the confirmation.
    const changed = mintReducer(confirmed, { type: 'FEE_RATE_SET', feeRate: 90 });
    expect(changed.highFeeConfirmed).toBe(false);
  });

  it('will not quote for an invalid file, an out-of-range fee, or without a recipient', () => {
    const noRecipient = run([{ type: 'WALLET_CONNECTED', wallet }, { type: 'FILE_SET', file }]);
    expect(shouldQuote(noRecipient)).toBe(false);
    expect(disabledReason(noRecipient)).toMatch(/taproot/i);

    const badFile = mintReducer(readyState(), { type: 'FILE_SET', file: { ...file, valid: false } });
    expect(shouldQuote(badFile)).toBe(false);

    const badFee = mintReducer(readyState(), { type: 'FEE_RATE_SET', feeRate: 0.01 });
    expect(shouldQuote(badFee)).toBe(false);
    expect(disabledReason(badFee)).toMatch(/out of range/i);
  });

  it('disconnecting the wallet clears quote and recipient', () => {
    const s = mintReducer(quotedState(), { type: 'WALLET_DISCONNECTED' });
    expect(s.phase).toBe('fileReady');
    expect(s.wallet).toBeNull();
    expect(s.recipient).toBeNull();
    expect(s.quote).toBeNull();
    expect(disabledReason(s)).toMatch(/connect a wallet/i);
  });

  it('clearing the file returns to idle', () => {
    const s = mintReducer(quotedState(), { type: 'FILE_CLEARED' });
    expect(s.phase).toBe('idle');
    expect(s.quote).toBeNull();
  });
});
