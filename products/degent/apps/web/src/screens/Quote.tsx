import { useEffect, useId, useState } from 'react';
import { TIER_LABELS } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { openOrder, verifyCommit } from '../flow/effects';
import { canEnter } from '../flow/reducer';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Fact, Money, Mono, Panel, errorText, useNow } from '../components/ui';
import { formatCountdown, formatEta, formatFeeRate, groupDigits, ordinal } from '../lib/format';

type Preset = 'economy' | 'normal' | 'priority' | 'custom';

export function QuoteScreen() {
  const { state, dispatch, services, vault, app } = useMint();
  const config = state.config!;
  const order = state.order!;
  const quote = order.quote!;
  const now = useNow(1000);
  const customId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fees = state.fees;
  const presets: Array<{ id: Exclude<Preset, 'custom'>; label: string; rate: number | undefined }> = [
    { id: 'economy', label: 'Economy', rate: fees?.economy },
    { id: 'normal', label: 'Normal', rate: fees?.normal },
    { id: 'priority', label: 'Priority', rate: fees?.priority },
  ];
  const rate = state.feeRate ?? quote.feeRate;
  const matchedPreset = presets.find((p) => p.rate === rate)?.id;
  const [preset, setPreset] = useState<Preset>(matchedPreset ?? 'custom');
  const [customText, setCustomText] = useState(String(rate));
  const minRate = Math.max(config.minFeeRate, fees?.minimum ?? 0);
  const rateChanged = rate !== quote.feeRate;

  // Recompute the commit address locally and compare with the service's.
  useEffect(() => {
    if (!state.artwork) return;
    try {
      const r = verifyCommit(services, { order, artwork: state.artwork, config, network: app.network });
      dispatch({ type: 'COMMIT_CHECKED', localAddress: r.localAddress, match: r.match });
    } catch (e) {
      dispatch({ type: 'COMMIT_CHECKED', localAddress: `error: ${errorText(e)}`, match: false });
    }
  }, [order, state.artwork, config, app.network, services, dispatch]);

  const expiresAt = Date.parse(quote.expiresAt);
  const secondsLeft = Math.floor((expiresAt - now) / 1000);
  useEffect(() => {
    if (secondsLeft <= 0 && !state.quoteExpired) dispatch({ type: 'QUOTE_EXPIRED' });
  }, [secondsLeft, state.quoteExpired, dispatch]);

  const choose = (p: Preset, r?: number) => {
    setPreset(p);
    if (r !== undefined) {
      dispatch({ type: 'FEE_RATE_SET', feeRate: r });
      setCustomText(String(Math.max(minRate, r)));
    }
  };

  const commitCustom = (text: string) => {
    const n = Number(text);
    const clamped = Number.isFinite(n) ? Math.max(minRate, n) : minRate;
    setCustomText(String(clamped));
    dispatch({ type: 'FEE_RATE_SET', feeRate: clamped });
  };

  const requote = async () => {
    setBusy(true);
    setError(null);
    try {
      vault.discard(order.id);
      const o = await openOrder(
        { services, vault, pollMs: Math.min(app.pollIntervalMs, 1000) },
        { tier: state.tier, artwork: state.artwork!, wallet: state.wallet!, feeRate: rate },
      );
      dispatch({ type: 'ORDER_UPDATED', order: o });
      if (!o.review?.approved) dispatch({ type: 'GO', step: 'validate' });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const isBlock = quote.lane === 'block';
  const tierLabel = TIER_LABELS[quote.tier];
  const rule = config.tiers.find((t) => t.tier === quote.tier);
  // ADR-0005 §3: a Standard Degent can travel the block lane (weight > 400,000 WU). Say it plainly.
  const laneSurprise = rule !== undefined && rule.lane !== quote.lane;
  const sharesBlock = rule?.sharesBlock ?? true;
  const canPay = canEnter(state, 'pay') && !rateChanged && !busy;

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 5 of 7"
        title="The bill, itemised."
        lede="Every sat accounted for. The commit address is recomputed in your browser from your key, your bytes and the parent — if it differs from the service’s, you cannot pay."
      />

      <Panel title="Fee rate">
        <div role="radiogroup" aria-label="Fee rate" className="rates">
          {presets.map((p) => (
            <label key={p.id} className={`rate ${preset === p.id ? 'is-on' : ''}`}>
              <input
                type="radio"
                name="rate"
                checked={preset === p.id}
                disabled={p.rate === undefined}
                onChange={() => choose(p.id, p.rate)}
              />
              <span className="rate__name">{p.label}</span>
              <span className="mono">{p.rate !== undefined ? formatFeeRate(Math.max(minRate, p.rate)) : '—'}</span>
            </label>
          ))}
          <label className={`rate ${preset === 'custom' ? 'is-on' : ''}`}>
            <input type="radio" name="rate" checked={preset === 'custom'} onChange={() => choose('custom')} />
            <span className="rate__name">Custom</span>
            <span className="small muted">min {formatFeeRate(minRate)}</span>
          </label>
        </div>
        {preset === 'custom' ? (
          <div className="field field--inline">
            <label htmlFor={customId} className="label">
              Custom rate (sat/vB)
            </label>
            <input
              id={customId}
              type="number"
              inputMode="decimal"
              min={minRate}
              step="0.1"
              value={customText}
              onChange={(e) => setCustomText(e.currentTarget.value)}
              onBlur={(e) => commitCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCustom(e.currentTarget.value);
              }}
            />
          </div>
        ) : null}
        {isBlock && fees?.blockRecommended ? (
          <p className="small muted">Block-lane recommendation: {formatFeeRate(fees.blockRecommended)}.</p>
        ) : null}
        {rateChanged ? (
          <Alert tone="info" title={`Re-quote at ${formatFeeRate(rate)}?`}>
            The quote below is for {formatFeeRate(quote.feeRate)}. A new rate means a new order (fresh one-time key, same
            bytes, a quick re-review).
            <div className="actions">
              <Button busy={busy} onClick={() => void requote()}>
                Re-quote at {formatFeeRate(rate)}
              </Button>
            </div>
          </Alert>
        ) : null}
        {error ? <Alert tone="bad" title="Could not re-quote">{error}</Alert> : null}
      </Panel>

      <Panel title="Breakdown" kicker={`${tierLabel} · ${quote.lane} lane`}>
        <table className="bill">
          <caption className="sr-only">Quote breakdown</caption>
          <tbody>
            <tr>
              <th scope="row">Reveal transaction</th>
              <td className="mono">
                {groupDigits(quote.revealWeight)} WU · {groupDigits(quote.revealVsize)} vB
              </td>
            </tr>
            <tr>
              <th scope="row">
                Reveal fee <span className="muted small">({groupDigits(quote.revealVsize)} vB × {formatFeeRate(quote.feeRate)})</span>
              </th>
              <td data-testid="reveal-fee">
                <Money sats={quote.revealFeeSats} />
              </td>
            </tr>
            <tr>
              <th scope="row">
                Postage <span className="muted small">(sats that travel with your Degent)</span>
              </th>
              <td>
                <Money sats={quote.postageSats} />
              </td>
            </tr>
            <tr className="bill__sub">
              <th scope="row">Commit output = reveal fee + postage</th>
              <td>
                <Money sats={quote.commitValueSats} />
              </td>
            </tr>
            <tr>
              <th scope="row">Service fee</th>
              <td>{quote.serviceFeeSats > 0 ? <Money sats={quote.serviceFeeSats} /> : <span className="mono">none</span>}</td>
            </tr>
            <tr className="bill__total">
              <th scope="row">Total</th>
              <td data-testid="total">
                <Money sats={quote.totalSats} strong />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small muted">
          Plus the network fee of your funding transaction, which depends on your wallet’s coins and is shown exactly before
          you sign.
        </p>
        <dl className="facts facts--inline">
          <Fact label="Tier">{tierLabel}</Fact>
          <Fact label="Lane">
            {isBlock ? (sharesBlock ? 'Block lane (shares a block by weight)' : 'Block lane (a block of its own)') : 'Standard mempool'}
          </Fact>
          {isBlock ? (
            <Fact label="Block slot">
              {quote.queuePosition !== null ? <span className="mono">{ordinal(quote.queuePosition)} block</span> : '—'}
            </Fact>
          ) : null}
          <Fact label="ETA">
            <span className="mono">{formatEta(quote.etaMinutes)}</span>
            {isBlock ? <span className="small muted"> (block slot × ~10 min — an estimate, not a promise)</span> : null}
          </Fact>
          <Fact label="Quote expires in">
            <span className="mono" role="timer" aria-live="off">
              {state.quoteExpired ? 'expired' : formatCountdown(secondsLeft)}
            </span>
          </Fact>
        </dl>
        {laneSurprise && isBlock ? (
          <Alert tone="warn" title={`Your ${tierLabel} travels the block lane`}>
            Its reveal weighs {groupDigits(quote.revealWeight)} WU, over the 400,000 WU limit for standard relay, so it goes
            through Libre Relay / Slipstream, shares a block by weight and waits for a block slot ({quote.queuePosition !== null ? ordinal(quote.queuePosition) : '—'},
            {' '}{formatEta(quote.etaMinutes)}). Same tier, same price rules; only the transport differs. Trimming a few kB in
            Create keeps it on the standard lane.
          </Alert>
        ) : null}
        {isBlock && quote.tier === 'large' ? (
          <Alert tone="warn" title="Large Degent: read this twice">
            You are buying a large part of a Bitcoin block: <Money sats={quote.revealFeeSats} /> in reveal fees at{' '}
            {formatFeeRate(quote.feeRate)}. Your reveal shares a block with other Large Degents when the weights fit the
            3,990,000 WU budget, otherwise it waits for the next slot. Your funds are never stranded — if the service fails
            to reveal, you rescue it yourself with the key in your recovery bundle.
          </Alert>
        ) : null}
        {quote.tier === 'fullblock' ? (
          <Alert tone="warn" title="Full Block Degent: read this twice">
            You are buying a whole Bitcoin block: <Money sats={quote.revealFeeSats} /> in reveal fees at{' '}
            {formatFeeRate(quote.feeRate)}. A Full Block Degent is never shared, so you wait for a block slot of your own.
            Your funds are never stranded — if the service fails to reveal, you rescue it yourself with the key in your
            recovery bundle.
          </Alert>
        ) : null}
        {state.quoteExpired ? (
          <Alert tone="warn" title="Quote expired">
            Fees move. Re-quote to lock a fresh price — nothing has been paid.
            <div className="actions">
              <Button busy={busy} onClick={() => void requote()}>
                Refresh quote
              </Button>
            </div>
          </Alert>
        ) : null}
      </Panel>

      <Panel title="Commit address">
        <dl className="facts">
          <Fact label="Service says">
            <Mono wrap>{quote.commitAddress ?? '(not yet binding)'}</Mono>
          </Fact>
          <Fact label="Your browser computed">
            <Mono wrap>{state.localCommitAddress ?? '…'}</Mono>
          </Fact>
        </dl>
        <div aria-live="polite">
          {state.commitCheck === 'match' ? (
            <p className="verified">
              <Badge tone="good">✓ Verified: matches service</Badge>
              <span className="small muted"> Recomputed with @bsh/inscription from your one-time key, your exact bytes and the club’s parent.</span>
            </p>
          ) : state.commitCheck === 'mismatch' ? (
            <Alert tone="bad" title="Blocked: commit address mismatch">
              The address the service asked you to fund is not the one your browser derives. Paying it could lose your
              funds, so payment is disabled. Start over, and tell the club if this persists.
            </Alert>
          ) : (
            <p className="muted">Checking…</p>
          )}
        </div>
      </Panel>

      <div className="actions">
        <Button variant="ghost" onClick={() => dispatch({ type: 'GO', step: 'validate' })}>
          Back
        </Button>
        <Button disabled={!canPay} onClick={() => dispatch({ type: 'GO', step: 'pay' })}>
          Continue to Pay
        </Button>
      </div>
    </div>
  );
}
