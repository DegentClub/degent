import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Stepper, { currentStep } from '@/components/Stepper';
import { ToastProvider, useToast } from '@/components/Toast';
import MintButton from '@/components/MintButton';
import { initialMintState, mintReducer, type MintState } from '@/lib/mint-machine';

const wallet = { walletId: 'unisat', walletName: 'UniSat', address: 'bc1qsender', network: 'mainnet' };
const file = { hash: 'h', size: 250_000, name: 'a.png', type: 'image/png', valid: true };

function quoted(): MintState {
  let s = initialMintState;
  s = mintReducer(s, { type: 'WALLET_CONNECTED', wallet });
  s = mintReducer(s, { type: 'RECIPIENT_SET', recipient: 'bc1precipient' });
  s = mintReducer(s, { type: 'FILE_SET', file });
  const key = { feeRate: s.feeRate, fileHash: 'h', recipient: 'bc1precipient' };
  s = mintReducer(s, { type: 'QUOTE_STARTED', requestId: 1, key });
  s = mintReducer(s, {
    type: 'QUOTE_SUCCEEDED',
    requestId: 1,
    quote: { key, paymentAddress: 'bc1qpay', amountSats: 20_000, inscriptionId: 'insc' },
  });
  return s;
}

describe('Stepper', () => {
  it('derives the current step from machine state', () => {
    expect(currentStep(initialMintState)).toBe(0);
    expect(currentStep(mintReducer(initialMintState, { type: 'WALLET_CONNECTED', wallet }))).toBe(1);
    expect(currentStep(quoted())).toBe(2);
    expect(currentStep(mintReducer(quoted(), { type: 'PAY_STARTED' }))).toBe(3);
    const submitted = mintReducer(mintReducer(quoted(), { type: 'PAY_STARTED' }), { type: 'PAY_SUCCEEDED', txid: 't' });
    expect(currentStep(submitted)).toBe(4);
  });

  it('marks the active step for assistive tech', () => {
    render(<Stepper state={quoted()} />);
    const current = screen.getByText(/Review: current step/);
    expect(current.closest('li')).toHaveAttribute('aria-current', 'step');
  });
});

describe('Toast', () => {
  function Trigger() {
    const { notify } = useToast();
    return (
      <button type="button" onClick={() => notify('Something broke', 'error')}>
        boom
      </button>
    );
  }

  it('renders errors in a live region and can be dismissed', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText('boom'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something broke');
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MintButton', () => {
  it('enables the button only with a fresh quote and shows the cost in sats, BTC and USD', () => {
    const onMint = vi.fn();
    render(<MintButton state={quoted()} dispatch={() => undefined} presets={null} usdPerBtc={50_000} onMint={onMint} />);
    const button = screen.getByRole('button', { name: /pay and mint/i });
    expect(button).toBeEnabled();
    expect(screen.getByText('20,000 sats')).toBeInTheDocument();
    expect(screen.getByText(/0\.0002 BTC · \$10/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(onMint).toHaveBeenCalledTimes(1);
  });

  it('is disabled while paying and after submission', () => {
    const paying = mintReducer(quoted(), { type: 'PAY_STARTED' });
    const { rerender } = render(
      <MintButton state={paying} dispatch={() => undefined} presets={null} usdPerBtc={null} onMint={() => undefined} />
    );
    expect(screen.getByRole('button', { name: /waiting for wallet/i })).toBeDisabled();
    const submitted = mintReducer(paying, { type: 'PAY_SUCCEEDED', txid: 't' });
    rerender(<MintButton state={submitted} dispatch={() => undefined} presets={null} usdPerBtc={null} onMint={() => undefined} />);
    expect(screen.getByRole('button', { name: /payment sent/i })).toBeDisabled();
  });

  it('does not clamp while typing but clamps on blur', () => {
    const dispatch = vi.fn();
    render(<MintButton state={quoted()} dispatch={dispatch} presets={null} usdPerBtc={null} onMint={() => undefined} />);
    const input = screen.getByLabelText(/fee rate/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: '0.1' } });
    });
    expect(input.value).toBe('0.1');
    expect(dispatch).toHaveBeenCalledWith({ type: 'FEE_RATE_SET', feeRate: 0.1 });
    expect(screen.getByText(/must be between/i)).toBeInTheDocument();
    act(() => {
      fireEvent.blur(input);
    });
    expect(input.value).toBe('0.13');
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'FEE_RATE_SET', feeRate: 0.13 });
  });

  it('asks for confirmation above the warning threshold', () => {
    const dispatch = vi.fn();
    const high = mintReducer(quoted(), { type: 'FEE_RATE_SET', feeRate: 120 });
    render(<MintButton state={high} dispatch={dispatch} presets={null} usdPerBtc={null} onMint={() => undefined} />);
    expect(screen.getByRole('button', { name: /pay and mint/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /I understand/i }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'HIGH_FEE_CONFIRMED' });
  });
});
