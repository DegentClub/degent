'use client';

import { useEffect, useState, type Dispatch } from 'react';
import {
  FEE_MAX,
  FEE_MIN,
  FEE_WARN,
  clampFeeRate,
  estimateFeeSats,
  formatBtc,
  formatUsd,
  isFeeRateInRange,
  type FeePresets,
} from '@/lib/fees';
import {
  canMint,
  disabledReason,
  hasFreshQuote,
  requiresHighFeeConfirmation,
  type MintAction,
  type MintState,
} from '@/lib/mint-machine';

interface MintButtonProps {
  state: MintState;
  dispatch: Dispatch<MintAction>;
  presets: FeePresets | null;
  usdPerBtc: number | null;
  onMint: () => void;
}

function CostLine({ sats, usdPerBtc, label }: { sats: number; usdPerBtc: number | null; label: string }) {
  return (
    <div className="degent-field-bg">
      <span className="text-gray-400">{label}</span>
      <span className="text-right">
        <strong>{sats.toLocaleString()} sats</strong>
        <span className="block text-xs text-degent-muted">
          {formatBtc(sats)} BTC{usdPerBtc ? ` · ${formatUsd(sats, usdPerBtc)}` : ''}
        </span>
      </span>
    </div>
  );
}

export default function MintButton({ state, dispatch, presets, usdPerBtc, onMint }: MintButtonProps) {
  const [feeText, setFeeText] = useState(String(state.feeRate));
  const [feeError, setFeeError] = useState<string | null>(null);

  // Keep the field in sync when the rate changes from outside (presets, reset).
  useEffect(() => {
    setFeeText((current) => (Number(current) === state.feeRate ? current : String(state.feeRate)));
  }, [state.feeRate]);

  const locked = state.phase === 'paying' || state.phase === 'submitted' || state.phase === 'confirmed';
  const enabled = canMint(state);
  const reason = disabledReason(state);
  const quoteFresh = hasFreshQuote(state);
  const needsHighFeeConfirm = requiresHighFeeConfirmation(state);

  const setRate = (rate: number) => {
    dispatch({ type: 'FEE_RATE_SET', feeRate: rate });
  };

  const handleFeeInput = (value: string) => {
    setFeeText(value);
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      setFeeError('Enter a number');
      return;
    }
    setFeeError(isFeeRateInRange(parsed) ? null : `Must be between ${FEE_MIN} and ${FEE_MAX} sat/vB`);
    setRate(parsed);
  };

  const commitFee = () => {
    const clamped = clampFeeRate(Number(feeText));
    setFeeText(String(clamped));
    setFeeError(null);
    setRate(clamped);
  };

  const estimateSats = state.file && isFeeRateInRange(state.feeRate) ? estimateFeeSats(state.file.size, state.feeRate) : null;

  return (
    <section className="degent-card" aria-labelledby="mint-title">
      <h2 id="mint-title" className="degent-title h2">
        <span className="icon-square">
          <i className="fa-solid fa-rocket text-degent-green" aria-hidden="true"></i>
        </span>
        <span>
          Review and <strong>submit your Degent</strong>
        </span>
      </h2>

      <div className="degent-card-2">
        <label htmlFor="fee-rate" className="label-icon">
          <i className="fas fa-tachometer-alt text-degent-green text-lg" aria-hidden="true"></i>
          Fee rate (sat/vB)
        </label>

        {presets && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Fee presets">
            {(['economy', 'normal', 'fast'] as const).map((key) => (
              <button
                key={key}
                type="button"
                disabled={locked}
                onClick={() => {
                  setFeeText(String(presets[key]));
                  setFeeError(null);
                  setRate(presets[key]);
                }}
                aria-pressed={state.feeRate === presets[key]}
                className={`btn !py-2 !text-sm flex-1 ${state.feeRate === presets[key] ? 'btn-neon' : 'btn-idle'}`}
              >
                <span className="capitalize">{key}</span>
                <span className="block text-xs opacity-80">{presets[key]} sat/vB</span>
              </button>
            ))}
          </div>
        )}
        {presets && !presets.live && (
          <p className="text-xs text-degent-muted">Live fee data unavailable; presets are static defaults.</p>
        )}

        <input
          id="fee-rate"
          type="number"
          inputMode="decimal"
          value={feeText}
          disabled={locked}
          onChange={(e) => handleFeeInput(e.target.value)}
          onBlur={commitFee}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitFee();
          }}
          min={FEE_MIN}
          max={FEE_MAX}
          step="0.01"
          aria-invalid={feeError ? true : undefined}
          aria-describedby="fee-help"
          className="bg-degent-input border border-degent-border flex-grow focus:border-degent-green focus:ring-1 focus:ring-degent-green outline-none px-5 py-3 rounded-degent-button text-white transition-colors w-full"
        />
        <p id="fee-help" className={`info-text ${feeError ? '!text-red-400' : ''}`}>
          <i className="fa-circle-info fas" aria-hidden="true"></i>
          {feeError ?? `Higher rates confirm faster. Allowed range: ${FEE_MIN}–${FEE_MAX} sat/vB.`}
        </p>
      </div>

      {needsHighFeeConfirm && !locked && (
        <div className="degent-card-2 !border-degent-orange/50" role="alert">
          <p className="text-degent-orange">
            <i className="fas fa-triangle-exclamation mr-2" aria-hidden="true"></i>
            {state.feeRate} sat/vB is above {FEE_WARN} sat/vB. That is unusually expensive; double-check before continuing.
          </p>
          <button type="button" onClick={() => dispatch({ type: 'HIGH_FEE_CONFIRMED' })} className="btn btn-flex btn-neon !py-2 !text-sm">
            <i className="fas fa-check" aria-hidden="true"></i>I understand, use {state.feeRate} sat/vB
          </button>
        </div>
      )}

      {state.phase === 'quoting' && (
        <div className="degent-block-border-top text-center" role="status">
          <div className="text-bitcoin text-md animate-pulse">
            <i className="fas fa-hourglass-start mr-2" aria-hidden="true"></i>
            Fetching quote at {state.feeRate} sat/vB…
          </div>
        </div>
      )}

      {state.quote && quoteFresh && state.phase !== 'quoting' && (
        <div className="degent-card-2">
          <CostLine sats={state.quote.amountSats} usdPerBtc={usdPerBtc} label="Total to pay" />
          <div className="degent-field-bg">
            <span className="text-gray-400 mb-1">Payment address</span>
            <span className="text-bitcoin text-sm break-all">{state.quote.paymentAddress}</span>
          </div>
        </div>
      )}

      {!quoteFresh && state.phase !== 'quoting' && estimateSats !== null && (
        <div className="degent-card-2">
          <CostLine sats={estimateSats} usdPerBtc={usdPerBtc} label="Rough estimate" />
          <p className="text-xs text-degent-muted">Exact amount comes from the quote once your image and wallet are ready.</p>
        </div>
      )}

      <button
        type="button"
        onClick={onMint}
        disabled={!enabled}
        className={`w-full btn btn-flex ${enabled ? 'btn-gradient cursor-pointer' : 'btn-disabled'}`}
      >
        {state.phase === 'paying' ? (
          <>
            <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
            Waiting for wallet…
          </>
        ) : state.phase === 'submitted' || state.phase === 'confirmed' ? (
          <>
            <i className="fas fa-check" aria-hidden="true"></i>
            Payment sent
          </>
        ) : (
          <>
            <i className="fas fa-rocket" aria-hidden="true"></i>
            Pay and mint
          </>
        )}
      </button>

      {reason && state.phase !== 'paying' && (
        <p className="info-text" role="status">
          <i className="fa-circle-info fas" aria-hidden="true"></i>
          <span className="disabled-reason">{reason}</span>
        </p>
      )}

      {state.phase === 'failed' && state.error && (
        <div className="info-text status error" role="alert">
          <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
          <span className="flex-1">{state.error}</span>
          <button type="button" onClick={() => dispatch({ type: 'RETRY' })} className="btn btn-flex btn-idle !py-1 !px-3 !text-xs">
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
