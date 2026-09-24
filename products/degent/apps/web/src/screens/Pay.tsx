import { useState } from 'react';
import { useMint } from '../flow/context';
import { preparePayment, signAndBroadcast } from '../flow/effects';
import type { PayPhase } from '../flow/state';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Button, CopyBlock, Fact, Money, Mono, Panel, errorText } from '../components/ui';
import { recoveryJson, RECOVERY_WARNING } from '../lib/recovery';
import { formatFeeRate, groupDigits, shortHash } from '../lib/format';
import { FUNDING_LABELS } from '../lib/funding';
import { artworkQuote } from '../services/types';

const PHASE_TEXT: Partial<Record<PayPhase, string>> = {
  'fetching-utxos': 'Looking up your payment coins…',
  building: 'Building the funding transaction and pre-signing the reveal…',
  'submitting-reveal': 'Handing the half-signed reveal to the mint…',
  'recovery-saved': 'Recovery bundle saved, with your one-time key inside. The key has been wiped from this tab’s memory.',
  'awaiting-wallet': 'Waiting for your wallet — approve the funding transaction there.',
  broadcasting: 'Broadcasting…',
};

export function Pay() {
  const { state, dispatch, services, vault, app, store } = useMint();
  const { order, wallet, artwork, config, pay } = state;
  const quote = order!.quote!;
  const [kept, setKept] = useState(false);
  const prepared = pay.funding !== null && state.recovery !== null;
  const working = ['fetching-utxos', 'building', 'submitting-reveal', 'awaiting-wallet', 'broadcasting'].includes(pay.phase);

  const prepare = async () => {
    try {
      const r = await preparePayment(
        { services, vault, app, store },
        {
          order: order!,
          artwork: artwork!,
          wallet: wallet!,
          config: config!,
          onPhase: (p) => {
            if (p !== 'recovery-saved') dispatch({ type: 'PAY_PHASE', phase: p });
          },
        },
      );
      dispatch({ type: 'FUNDING_BUILT', funding: r.funding });
      dispatch({ type: 'ORDER_UPDATED', order: r.order });
      dispatch({ type: 'RECOVERY_SAVED', bundle: r.bundle, savedLocally: r.savedLocally });
    } catch (e) {
      dispatch({ type: 'PAY_FAILED', error: errorText(e) });
    }
  };

  const sign = async () => {
    try {
      const txid = await signAndBroadcast(
        { services },
        { wallet: wallet!, funding: pay.funding!, onPhase: (p) => dispatch({ type: 'PAY_PHASE', phase: p }) },
      );
      dispatch({ type: 'FUNDING_BROADCAST', txid });
    } catch (e) {
      dispatch({ type: 'PAY_FAILED', error: errorText(e) });
    }
  };

  const f = pay.funding;
  return (
    <div className="screen">
      <ScreenHeading
        step="Step 6 of 7"
        title="Settle the account."
        lede="Two steps, in this order, so your sats can never be stranded."
      />

      <Panel title="What happens">
        <ol className="howto">
          <li>
            <strong>Prepare.</strong> A one-time key — generated in this tab, never sent anywhere — pre-signs the reveal that
            delivers your Degent to <Mono>{shortHash(wallet!.ordinals.address, 8)}</Mono> and returns the club’s parent to{' '}
            <Mono>{shortHash(config!.collectionAddress, 8)}</Mono> (every output is signed, so nobody can add or change one).
            The half-signed reveal goes to the mint; the key goes into <em>your</em> recovery bundle, saved on this device,
            and is wiped from memory.
          </li>
          <li>
            <strong>Sign.</strong> Your wallet signs one funding transaction. We check it is exactly the one the reveal was
            signed against, then broadcast it.
          </li>
        </ol>
      </Panel>

      <Panel title="1 · Prepare">
        <div aria-live="polite" className="status-line">
          {PHASE_TEXT[pay.phase] ?? (prepared ? '' : 'Ready when you are.')}
        </div>
        {!prepared ? (
          <div className="actions">
            <Button variant="ghost" disabled={working} onClick={() => dispatch({ type: 'GO', step: 'quote' })}>
              Back to quote
            </Button>
            <Button busy={working} onClick={() => void prepare()}>
              Prepare payment
            </Button>
          </div>
        ) : null}
        {f ? (
          <dl className="facts">
            <Fact label="Funding txid (known before you sign)">
              <Mono wrap>{f.txid}</Mono>
            </Fact>
            <Fact label="Pays">
              <ul className="plain">
                {f.selection.outputs.map((o, i) => (
                  <li key={i}>
                    <span className="muted small">{FUNDING_LABELS[o.label]}</span>{' '}
                    <Money sats={o.value} /> → <Mono>{shortHash(o.address, 8)}</Mono>
                  </li>
                ))}
              </ul>
            </Fact>
            <Fact label="Funding network fee">
              <Money sats={f.selection.fee} />{' '}
              <span className="small muted">
                ({groupDigits(f.selection.vsize)} vB at {formatFeeRate(quote.feeRate)}, {f.selection.inputs.length} coin
                {f.selection.inputs.length === 1 ? '' : 's'})
              </span>
            </Fact>
            <Fact label="You spend in total">
              <Money sats={f.selection.outputs.filter((o) => o.label !== 'change').reduce((s, o) => s + o.value, 0) + f.selection.fee} strong />
            </Fact>
          </dl>
        ) : null}
        {f && f.notes.length > 0 ? (
          <Alert tone="info" title="Note">
            {f.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </Alert>
        ) : null}
        {f && f.selection.excluded.length > 0 ? (
          <p className="small muted">
            Skipped {f.selection.excluded.length} small coin(s) that might hold inscriptions.
          </p>
        ) : null}
      </Panel>

      {state.recovery ? (
        <Panel title="Your recovery bundle" kicker="Keep a copy before you sign">
          <p>
            {pay.recoverySavedLocally
              ? 'Saved on this device. '
              : 'This browser would not let us save it locally — copying it is essential. '}
            It contains your one-time reveal key (<Mono>revealPrivkey</Mono>), your exact bytes and the order facts. With it you
            can reveal your Degent yourself, without the mint, if it ever fails to deliver.
          </p>
          <Alert tone="warn" title="Keep it private — it holds a key">
            {RECOVERY_WARNING}
          </Alert>
          <p className="small muted">
            What that key can do: spend the commit output you are about to fund, and only into{' '}
            <Mono>{shortHash(wallet!.ordinals.address, 8)}</Mono> through the inscription script. What it cannot do: touch any
            other coin in your wallet. Nobody but you holds it; the mint never sees it.
          </p>
          <CopyBlock label="Recovery bundle (JSON)" text={recoveryJson(state.recovery)} rows={10} />
          <label className="check">
            <input type="checkbox" checked={kept} onChange={(e) => setKept(e.currentTarget.checked)} />
            <span>
              <span className="check__label">I have kept a copy of my recovery bundle.</span>
            </span>
          </label>
        </Panel>
      ) : null}

      {prepared ? (
        <Panel title="2 · Sign & broadcast">
          <p>
            Your wallet ({wallet!.name}) will show one transaction paying <Money sats={quote.commitValueSats} /> to the commit
            address{artworkQuote(quote)?.artistRoyaltySats ? ', the artist’s royalty' : ''}{quote.serviceFeeSats > 0 ? ' and the club fee' : ''}. Do not edit it — a
            changed transaction (any output’s script or value, or the id) will be refused before broadcast.
          </p>
          <div className="actions">
            <Button busy={pay.phase === 'awaiting-wallet' || pay.phase === 'broadcasting'} disabled={!kept} onClick={() => void sign()}>
              Sign & broadcast with {wallet!.name}
            </Button>
          </div>
        </Panel>
      ) : null}

      {pay.phase === 'error' && pay.error ? (
        <Alert tone="bad" title="Payment did not go through">
          {pay.error}
          {prepared ? <p>Your recovery bundle is still valid; you can try signing again.</p> : <p>Nothing has been paid.</p>}
        </Alert>
      ) : null}
    </div>
  );
}
