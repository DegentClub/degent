/**
 * /verify?tg=<token> — the holders-only Telegram gate landing (`@bsh/degent-telegram-gate`,
 * contracts/openapi/degent-telegram-gate.yaml). Connect the wallet holding a Degent, fetch the gate's
 * Sign-in-with-Bitcoin challenge (it names the Telegram account), sign it unmodified (BIP-322), and post
 * {token, address, message, signature}. The invite arrives by Telegram DM; this page never shows one.
 */
import { useState } from 'react';
import { useMint } from '../flow/context';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, ExternalLink, Mono, Panel, errorText } from '../components/ui';
import type { WalletId, WalletSession } from '../services/types';

export function readGateToken(search: string): string | null {
  try {
    const t = new URLSearchParams(search).get('tg');
    return t && /^[A-Za-z0-9_-]{8,128}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function Verify({ search }: { search?: string }) {
  const { services, app } = useMint();
  const token = readGateToken(search ?? (typeof window !== 'undefined' ? window.location.search : ''));
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holder, setHolder] = useState<{ degents: number[] } | null>(null);
  const [result, setResult] = useState<{ message: string; degents: number[] } | null>(null);
  const wallets = services.wallets.list();

  const connect = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    try {
      const w = await services.wallets.connect(id, app.network);
      setWallet(w);
      const h = await services.mintApi.getHolder(w.ordinals.address);
      setHolder({ degents: h.degents });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!wallet || !token) return;
    setBusy('verify');
    setError(null);
    try {
      const address = wallet.ordinals.address;
      const ch = await services.gate.challenge(app.gateUrl, { token, address });
      if (!ch.ok) throw new Error(ch.message);
      const signature = await wallet.signMessage(ch.message, address);
      const res = await services.gate.submit(app.gateUrl, { token, address, message: ch.message, signature });
      if (!res.ok) throw new Error(res.message);
      setResult({ message: res.message, degents: res.degents });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen">
      <ScreenHeading step="Members’ lounge" title="Prove you hold a Degent." lede="The Telegram gate sent you here. Sign one message with the wallet that holds your Degent — no transaction, no fees — and the gate lets you in." />
      {!token ? (
        <Alert tone="warn" title="No gate token in the link">
          Open this page from the link the Telegram bot gave you (it ends in <Mono>?tg=…</Mono>).
        </Alert>
      ) : !app.gateUrl ? (
        <Alert tone="warn" title="Gate not configured">The site has no gate endpoint (VITE_GATE_URL). Ask the club’s operators.</Alert>
      ) : null}

      <Panel title="1 · Connect the wallet holding your Degent">
        <ul className="wallets" aria-label="Wallets">
          {wallets.map((opt) => (
            <li key={opt.id} className={`wallet ${opt.installed ? '' : 'wallet--missing'}`}>
              <span className="wallet__name">{opt.name}</span>
              {opt.installed ? <Badge tone="good">Installed</Badge> : <Badge>Not installed</Badge>}
              {opt.installed ? (
                <Button variant={wallet?.id === opt.id ? 'secondary' : 'primary'} busy={busy === opt.id} disabled={busy !== null} onClick={() => void connect(opt.id)} aria-label={`Connect ${opt.name}`}>
                  {wallet?.id === opt.id ? 'Reconnect' : 'Connect'}
                </Button>
              ) : (
                <ExternalLink href={opt.installUrl}>Install {opt.name}</ExternalLink>
              )}
            </li>
          ))}
        </ul>
        {wallet ? (
          <p className="small">
            <Mono wrap>{wallet.ordinals.address}</Mono>{' '}
            {holder ? (
              holder.degents.length ? (
                <Badge tone="good">holds Degent {holder.degents.map((n) => `#${n}`).join(', ')}</Badge>
              ) : (
                <Badge tone="bad">holds no Degent</Badge>
              )
            ) : null}
          </p>
        ) : null}
      </Panel>

      <Panel title="2 · Sign and enter">
        <p className="small">
          The gate asks your wallet to sign a message naming your address and your Telegram account, so it cannot be
          reused for anyone else. The gate checks the signature and the Register, then sends a single-use invite to your
          Telegram DMs.
        </p>
        <div className="actions">
          <Button busy={busy === 'verify'} disabled={!wallet || !token || !app.gateUrl || result !== null || (holder !== null && holder.degents.length === 0)} onClick={() => void verify()}>
            Sign & verify
          </Button>
        </div>
        <div aria-live="assertive">
          {result ? (
            <Alert tone="good" title="Verified">
              {result.message}
            </Alert>
          ) : null}
          {error ? <Alert tone="bad" title="Not verified">{error}</Alert> : null}
        </div>
      </Panel>
    </div>
  );
}
