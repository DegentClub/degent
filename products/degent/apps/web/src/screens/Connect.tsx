import { useState } from 'react';
import { useMint } from '../flow/context';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, ExternalLink, Fact, Mono, Panel, errorText } from '../components/ui';
import { classifyAddress, isLegacy, LegacyAddressError } from '../lib/funding';
import type { AddressType, WalletAccount, WalletId } from '../services/types';

const TYPE_NAMES: Record<AddressType, string> = {
  p2tr: 'Taproot',
  p2wpkh: 'Native SegWit',
  'p2sh-p2wpkh': 'Nested SegWit',
  p2pkh: 'Legacy',
  unknown: 'Unrecognised',
};

function typeOf(a: WalletAccount): AddressType {
  return a.addressType === 'unknown' ? classifyAddress(a.address) : a.addressType;
}

export function Connect() {
  const { state, dispatch, services, app } = useMint();
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallets = services.wallets.list();
  const w = state.wallet;
  const legacy = w ? isLegacy(w.payment) : false;
  const ordinalsNotTaproot = w ? typeOf(w.ordinals) !== 'p2tr' : false;

  const connect = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    try {
      const session = await services.wallets.connect(id, app.network);
      dispatch({ type: 'WALLET_CONNECTED', wallet: session });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 2 of 7"
        title="Present your credentials."
        lede="Any Bitcoin wallet that can sign a standard PSBT will do. You will sign exactly once: the funding transaction."
      />

      <Panel title="Choose a wallet">
        <ul className="wallets" aria-label="Wallets">
          {wallets.map((opt) => (
            <li key={opt.id} className={`wallet ${opt.installed ? '' : 'wallet--missing'}`}>
              <span className="wallet__name">{opt.name}</span>
              {opt.installed ? (
                <Badge tone="good">Installed</Badge>
              ) : (
                <Badge>Not installed</Badge>
              )}
              {opt.installed ? (
                <Button
                  variant={w?.id === opt.id ? 'secondary' : 'primary'}
                  busy={busy === opt.id}
                  disabled={busy !== null}
                  onClick={() => void connect(opt.id)}
                  aria-label={`Connect ${opt.name}`}
                >
                  {w?.id === opt.id ? 'Reconnect' : 'Connect'}
                </Button>
              ) : (
                <ExternalLink href={opt.installUrl}>Install {opt.name}</ExternalLink>
              )}
            </li>
          ))}
        </ul>
        {wallets.every((o) => !o.installed) ? (
          <Alert tone="info" title="No wallet extension detected">
            Install one of the wallets above, then reload this page. Extensions inject themselves when the page loads.
          </Alert>
        ) : null}
        <div aria-live="assertive">{error ? <Alert tone="bad" title="Could not connect">{error}</Alert> : null}</div>
      </Panel>

      <Panel kicker="Two addresses, two jobs" title="Ordinals vs payment">
        <div className="two-col">
          <div>
            <h3 className="h3">Ordinals address (Taproot, bc1p…)</h3>
            <p>
              Where your Degent is delivered. It holds inscriptions, so it should never be used to pay fees — good wallets
              keep it separate.
            </p>
          </div>
          <div>
            <h3 className="h3">Payment address (SegWit or Taproot)</h3>
            <p>
              Where the sats come from. It must be SegWit (bc1q… or 3…) or Taproot, because the funding transaction’s id
              has to be known <em>before</em> you sign so the reveal can be pre-signed against it.
            </p>
          </div>
        </div>
      </Panel>

      {w ? (
        <Panel title={`Connected: ${w.name}`}>
          <dl className="facts">
            <Fact label="Ordinals (receives the Degent)">
              <Mono wrap>{w.ordinals.address}</Mono> <Badge tone={ordinalsNotTaproot ? 'warn' : 'brass'}>{TYPE_NAMES[typeOf(w.ordinals)]}</Badge>
            </Fact>
            <Fact label="Payment (pays the mint)">
              <Mono wrap>{w.payment.address}</Mono> <Badge tone={legacy ? 'bad' : 'brass'}>{TYPE_NAMES[typeOf(w.payment)]}</Badge>
            </Fact>
          </dl>
          {w.payment.address === w.ordinals.address ? (
            <Alert tone="warn" title="One address for everything">
              This wallet pays from the same address that holds your inscriptions. We skip coins of 10,000 sats or less so
              an inscription is never spent as a fee — but a wallet with separate ordinals and payment accounts is safer.
            </Alert>
          ) : null}
          {legacy ? (
            <Alert tone="bad" title="Legacy payment address — cannot mint from it">
              {new LegacyAddressError(w.payment.address).message}
            </Alert>
          ) : null}
          {ordinalsNotTaproot ? (
            <Alert tone="warn" title="Ordinals address is not Taproot">
              Your Degent will still be delivered, but most ordinals tooling expects a Taproot (bc1p…) address.
            </Alert>
          ) : null}
          <div className="actions">
            <Button variant="ghost" onClick={() => dispatch({ type: 'BACK' })}>
              Back
            </Button>
            {state.handoff && state.artwork ? (
              <Button disabled={legacy} onClick={() => dispatch({ type: 'GO', step: 'validate' })}>
                Continue to Validate
              </Button>
            ) : (
              <Button disabled={legacy} onClick={() => dispatch({ type: 'GO', step: 'create' })}>
                Continue to Create
              </Button>
            )}
          </div>
        </Panel>
      ) : (
        <div className="actions">
          <Button variant="ghost" onClick={() => dispatch({ type: 'BACK' })}>
            Back
          </Button>
        </div>
      )}
    </div>
  );
}
