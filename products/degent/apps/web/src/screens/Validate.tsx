import { useMemo, useState } from 'react';
import { useMint } from '../flow/context';
import { laneForArtwork, openOrder } from '../flow/effects';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Panel, errorText } from '../components/ui';
import { allPassed, runLocalRules, type RuleCheck } from '../lib/rules';
import { formatBytesExact } from '../lib/format';

export function CheckList({ checks, label }: { checks: Array<Pick<RuleCheck, 'id' | 'passed' | 'detail'> & { label?: string }>; label: string }) {
  return (
    <ul className="checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.id} className={`checks__item ${c.passed ? 'is-pass' : 'is-fail'}`} data-testid={`check-${c.id}`}>
          <span className="checks__icon" aria-hidden="true">
            {c.passed ? '✓' : '✕'}
          </span>
          <span className="checks__text">
            <span className="checks__label">
              {c.label ?? c.id}
              <span className="sr-only">{c.passed ? ': passed' : ': failed'}</span>
            </span>
            <span className="checks__detail">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Validate() {
  const { state, dispatch, services, vault, app } = useMint();
  const config = state.config!;
  const art = state.artwork!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks = useMemo(() => runLocalRules(art, state.tier, config), [art, state.tier, config]);
  const localOk = allPassed(checks);
  const order = state.order;
  const review = order?.review ?? null;
  const reviewing = busy || order?.status === 'reviewing' || order?.status === 'awaiting_content';

  // Block-lane reveals (by weight, ADR-0005 §3) default to the block-lane fee recommendation.
  const lane = state.wallet
    ? laneForArtwork(services, { artwork: art, recipientAddress: state.wallet.ordinals.address, config, network: app.network }).lane
    : null;
  const defaultRate =
    state.feeRate ??
    (lane === 'block' ? state.fees?.blockRecommended : undefined) ??
    state.fees?.normal ??
    config.minFeeRate;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await openOrder(
        { services, vault, pollMs: Math.min(app.pollIntervalMs, 1000) },
        { tier: state.tier, artwork: art, wallet: state.wallet!, feeRate: Math.max(defaultRate, config.minFeeRate) },
      );
      dispatch({ type: 'ORDER_UPDATED', order: o });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 4 of 7"
        title="The doorman’s inspection."
        lede="First the collection rules run here, on your exact bytes. Then the bytes go to the mint for an automated art review. Nothing is payable until the art is approved."
      />

      <Panel title="Collection rules (checked in your browser)">
        <CheckList checks={checks} label="Local rule checks" />
        <p className="small muted">
          {formatBytesExact(art.size)} · {art.contentType} · {art.width}×{art.height}px
        </p>
        {!localOk ? (
          <Alert tone="bad" title="Fix these before review">
            Go back to Create and adjust the image. Nothing has been uploaded.
          </Alert>
        ) : null}
      </Panel>

      <Panel title="Automated art review">
        <div aria-live="polite">
          {!order && !busy ? <p>Upload the exact bytes for review. You can still change your art afterwards.</p> : null}
          {reviewing ? (
            <p className="status-line">
              <span className="spinner" aria-hidden="true" /> The doorman is inspecting your gentleman…
            </p>
          ) : null}
          {review ? (
            <>
              <p className="fitline">
                {review.approved ? <Badge tone="good">Approved</Badge> : <Badge tone="bad">Rejected</Badge>}{' '}
                <span className="small muted">
                  Order <span className="mono">{order!.id}</span>
                </span>
              </p>
              <CheckList checks={review.checks} label="Art review checks" />
              {!review.approved ? (
                <Alert tone="bad" title="Not admitted — you have paid nothing">
                  <ul>
                    {review.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  Adjust the art and submit again.
                </Alert>
              ) : null}
            </>
          ) : null}
        </div>
        {error ? <Alert tone="bad" title="Upload failed">{error}</Alert> : null}
        <div className="actions">
          <Button variant="ghost" onClick={() => dispatch({ type: 'GO', step: 'create' })}>
            Back to Create
          </Button>
          {review?.approved ? (
            <Button onClick={() => dispatch({ type: 'GO', step: 'quote' })}>See your quote</Button>
          ) : (
            <Button disabled={!localOk} busy={busy} onClick={() => void submit()}>
              {review && !review.approved ? 'Submit again' : 'Submit for review'}
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
