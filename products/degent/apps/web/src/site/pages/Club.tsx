import { useState } from 'react';
import { useAsync, useSite, errorMessage } from '../context';
import { useDocumentMeta } from '../lib/meta';
import { formatSiwb, randomNonce } from '../lib/siwb';
import { Link } from '../router';
import { Icon } from '../components/Icons';
import { Cta, DegentImage, ExternalA, Frame, Notice, SectionTitle } from '../components/ui';
import type { MessageSignatureType, WalletId, WalletSession } from '../../services/types';
import type { CollectionItem } from '../services/types';

interface SignedIn {
  wallet: WalletSession;
  address: string;
  method: MessageSignatureType;
  message: string;
  signature: string;
}

function YourDegents({ address }: { address: string }) {
  const { site } = useSite();
  const owned = useAsync(async (): Promise<CollectionItem[]> => {
    const [held, list] = await Promise.all([site.ord.getAddressInscriptions(address), site.collection.list()]);
    const byId = new Map(list.items.map((it) => [it.id, it]));
    return held.map((id) => byId.get(id)).filter((x): x is CollectionItem => !!x).sort((a, b) => a.number - b.number);
  }, [address, site]);
  if (owned.status === 'loading') return <p className="muted">Looking up the inscriptions held by your ordinals address…</p>;
  if (owned.status === 'error') return <Notice tone="bad" title="Could not read your inscriptions from ord">{owned.error}</Notice>;
  if (owned.value.length === 0)
    return (
      <Notice title="No Degents in this address yet">
        <p>
          Your ordinals address holds no Degents from the collection list. <Link to="/mint">Mint one</Link> or buy one on Magic Eden.
        </p>
      </Notice>
    );
  return (
    <ul className="gallery__grid" data-testid="owned">
      {owned.value.map((it) => (
        <li key={it.id}>
          <Link to={`/collection/${it.number}`} className="gallery__item" aria-label={`Degent #${it.number}`}>
            <Frame caption={`DEGENT #${it.number}`}>
              <DegentImage item={it} />
            </Frame>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Club() {
  const { mint, app, site } = useSite();
  useDocumentMeta({ title: 'The Club', description: 'Holder area: sign in with Bitcoin to see your Degents and member perks.' });
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<SignedIn | null>(null);
  const wallets = mint.wallets.list();

  const signIn = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    let wallet: WalletSession | null = null;
    try {
      wallet = await mint.wallets.connect(id, app.network);
      if (!wallet.signMessage) throw new Error(`${wallet.name} cannot sign messages.`);
      // BIP-322 where supported (signed by the ordinals address); Horizon signs ECDSA / BIP-137 only,
      // which cannot prove a Taproot address, so it signs with its SegWit payment address.
      const method: MessageSignatureType = wallet.capabilities?.bip322 === false ? 'ecdsa' : 'bip322-simple';
      const address = method === 'ecdsa' ? wallet.payment.address : wallet.ordinals.address;
      const domain = typeof window !== 'undefined' && window.location.host ? window.location.host : 'degent.club';
      const message = formatSiwb({ domain, address, network: app.network, nonce: randomNonce(), issuedAt: new Date(), ttlSeconds: 300 });
      const signature = await wallet.signMessage(message, address, method);
      setMe({ wallet, address, method, message, signature });
    } catch (e) {
      setError(errorMessage(e));
      if (wallet) void wallet.disconnect().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const signOut = () => {
    void me?.wallet.disconnect().catch(() => undefined);
    setMe(null);
  };

  return (
    <div className="container stack page-top">
      <SectionTitle level={1} kicker="Members" title="The Club" sub="Sign in with Bitcoin to see your Degents. Signing a message costs nothing and moves nothing." />
      {!me ? (
        <section className="card" aria-labelledby="signin-h">
          <h2 id="signin-h">Sign in with Bitcoin</h2>
          <p className="small muted">BIP-322 message signing where the wallet supports it; ECDSA (BIP-137) for Horizon.</p>
          <ul className="wallet-list">
            {wallets.map((w) => (
              <li key={w.id} className="wallet-list__row">
                <span className="wallet-list__name">{w.name}</span>
                {w.installed ? (
                  <button type="button" className="cta cta--gradient cta--sm" disabled={busy !== null} onClick={() => void signIn(w.id)} aria-label={`Sign in with ${w.name}`}>
                    <span>{busy === w.id ? 'Waiting for wallet…' : 'Sign in'}</span>
                  </button>
                ) : (
                  <ExternalA href={w.installUrl}>Install</ExternalA>
                )}
              </li>
            ))}
          </ul>
          {wallets.every((w) => !w.installed) ? <Notice title="No wallet extension detected">Install a wallet above, then reload this page.</Notice> : null}
          <div aria-live="assertive">{error ? <Notice tone="bad" title="Sign-in failed">{error}</Notice> : null}</div>
        </section>
      ) : (
        <>
          <section className="card" aria-labelledby="me-h" data-testid="signed-in">
            <h2 id="me-h">Welcome back, gentleman</h2>
            <p>
              Signed with <strong>{me.wallet.name}</strong> ({me.method === 'ecdsa' ? 'ECDSA / BIP-137' : 'BIP-322'}) as{' '}
              <span className="mono mono--wrap">{me.address}</span>
            </p>
            {me.method === 'ecdsa' ? (
              <p className="small muted">
                Your Degents are looked up at your ordinals address <span className="mono mono--wrap">{me.wallet.ordinals.address}</span>.
              </p>
            ) : null}
            <Notice tone="warn" title="Read-only membership view">
              The signature is checked by the Blockspace ID service when it is connected; until then this page only reads public chain data for
              the connected address and grants nothing{site.mode === 'demo' ? ' (demo: simulated wallet signature)' : ''}.
            </Notice>
            <button type="button" className="cta cta--dark cta--sm" onClick={signOut}>
              <span>Sign out</span>
            </button>
          </section>
          <section aria-labelledby="yours-h">
            <SectionTitle title="Your Degents" id="yours-h" sub="Inscriptions in your ordinals address that are in the collection list." />
            <YourDegents address={me.wallet.ordinals.address} />
          </section>
        </>
      )}
      <section className="card perks" aria-labelledby="perks-h">
        <h2 id="perks-h">Member perks</h2>
        <p className="muted">Coming soon. Perks for holders will be announced in the Degent Chronicles and on our channels.</p>
        <div className="cta-row">
          <Cta to="/blog" variant="dark" icon={<Icon.pen />}>
            Degent Chronicles
          </Cta>
        </div>
      </section>
    </div>
  );
}
