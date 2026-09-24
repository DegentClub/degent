import { useState } from 'react';
import { useMint } from '../flow/context';
import { preparePayment, signAndBroadcast } from '../flow/effects';
import type { PayPhase } from '../flow/state';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Button, CopyBlock, Fact, Money, Mono, Panel, errorText } from '../components/ui';
import { recoveryJson, RECOVERY_WARNING } from '../lib/recovery';
import { checkPassphrase, MIN_PASSPHRASE_LENGTH } from '../lib/keyCrypto';
import { formatFeeRate, groupDigits, shortHash } from '../lib/format';

const PHASE_TEXT: Partial<Record<PayPhase, string>> = {
  'fetching-utxos': 'Looking up your payment coins…',
  building: 'Building the funding transaction and pre-signing the reveal…',
  'submitting-reveal': 'Handing the half-signed reveal to the mint…',
  'recovery-saved': 'Recovery bundle saved. Your one-time key is kept only encrypted with your passphrase.',
  'awaiting-wallet': 'Waiting for your wallet — approve the funding transaction there.',
  broadcasting: 'Broadcasting…',
};

export function Pay() {
  const { state, dispatch, services, vault, app, store } = useMint();
  const { order, wallet, artwork, config, pay } = state;
  const quote = order!.quote!;
  const [kept, setKept] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const passphraseProblem = checkPassphrase(passphrase) ?? (passphrase !== confirmPassphrase ? 'The two passphrases differ.' : null);
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
          passphrase,
          onPhase: (p) => {
            if (p !== 'recovery-saved') dispatch({ type: 'PAY_PHASE', phase: p });
          },
        },
      );
      dispatch({ type: 'FUNDING_BUILT', funding: r.funding });
      dispatch({ type: 'ORDER_UPDATED', order: r.order });
      dispatch({ type: 'RECOVERY_SAVED', bundle: r.bundle, savedLocally: r.savedLocally });
      // The passphrase leaves memory with this screen's state; it is never stored or sent.
      setPassphrase('');
      setConfirmPassphrase('');
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
            delivers your Degent to <Mono>{shortHash(wallet!.ordinals.address, 8)}</Mono> and returns the club's parent to
            its address, exactly as quoted. The half-signed reveal goes to the mint. The key is then kept only{' '}
            <em>encrypted with your recovery passphrase</em> in a recovery bundle saved on this device — it is what lets you
            reveal your inscription yourself if the mint ever cannot — and wiped from memory.
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
          <div className="passphrase">
            <label className="label" htmlFor="recovery-passphrase">
              Recovery passphrase
            </label>
            <input
              id="recovery-passphrase"
              className="input"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              disabled={working}
              onChange={(e) => setPassphrase(e.currentTarget.value)}
            />
            <label className="label" htmlFor="recovery-passphrase-confirm">
              Repeat the passphrase
            </label>
            <input
              id="recovery-passphrase-confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmPassphrase}
              disabled={working}
              onChange={(e) => setConfirmPassphrase(e.currentTarget.value)}
            />
            <p className="small muted">
              At least {MIN_PASSPHRASE_LENGTH} characters. It encrypts your one-time key in the recovery bundle; you need it only
              to self-rescue. It is never stored or sent — if you lose it, the mint still delivers normally, but you cannot
              rescue on your own.
            </p>
            {passphrase.length > 0 && passphraseProblem ? <p className="small bad">{passphraseProblem}</p> : null}
          </div>
        ) : null}
        {!prepared ? (
          <div className="actions">
            <Button variant="ghost" disabled={working} onClick={() => dispatch({ type: 'GO', step: 'quote' })}>
              Back to quote
            </Button>
            <Button busy={working} disabled={passphraseProblem !== null} onClick={() => void prepare()}>
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
                    <span className="muted small">{o.label === 'commit' ? 'Commit (reveal fee + postage)' : o.label === 'service-fee' ? 'Service fee' : 'Change back to you'}</span>{' '}
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
            With it and your recovery passphrase you (or anyone you trust) can reveal your inscription without the mint, if it
            ever fails to deliver. Keep the passphrase somewhere else.
          </p>
          <Alert tone="warn" title="Keep it private">
            {RECOVERY_WARNING}
          </Alert>
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
            address{quote.serviceFeeSats > 0 ? ' and the service fee' : ''}. Do not edit it — a changed transaction will be
            refused before broadcast.
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
