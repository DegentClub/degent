import { useEffect, useId, useState } from 'react';
import { useMint } from '../flow/context';
import { useStudio } from '../flow/studio';
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Fact, Mono, Panel, errorText } from '../components/ui';
import { formatTimestamp, shortHash } from '../lib/format';
import { LegacyPayoutError, payoutAddressKind, payoutMessage } from '../lib/studioSession';
import type { ArtworkStatus, StudioArtwork } from '../services/studioApi';
import type { WalletId } from '../services/types';
import { AppealBadge, AppealForm, EditionsEditor, NotifySettings } from './StudioExtras';

const KIND_LABEL = { p2tr: 'Taproot', p2wpkh: 'Native SegWit', legacy: 'Legacy', unknown: 'Unrecognised' } as const;

export const ARTWORK_STATUS_COPY: Record<ArtworkStatus, { label: string; tone: 'neutral' | 'good' | 'bad' | 'warn' | 'brass' }> = {
  submitted: { label: 'Awaiting bytes', tone: 'neutral' },
  reviewing: { label: 'Under review', tone: 'warn' },
  approved: { label: 'Hanging', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' },
  delisted: { label: 'Delisted', tone: 'neutral' },
};

export function StatusPill({ artwork }: { artwork: Pick<StudioArtwork, 'status' | 'needsHuman'> }) {
  if (artwork.status === 'reviewing' && artwork.needsHuman) return <Badge tone="warn">Waiting for the house</Badge>;
  const c = ARTWORK_STATUS_COPY[artwork.status];
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

/** Wallet buttons for the studio (the mint's Connect step has its own richer version). */
export function WalletButtons() {
  const { services, app, dispatch } = useMint();
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installed = services.wallets.list().filter((w) => w.installed);
  const connect = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    try {
      dispatch({ type: 'WALLET_CONNECTED', wallet: await services.wallets.connect(id, app.network) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      {installed.length === 0 ? (
        <Alert tone="info" title="No wallet extension detected">
          Install a Bitcoin wallet (UniSat, Xverse, Leather, OKX, Magic Eden…) and reload this page.
        </Alert>
      ) : null}
      <div className="row">
        {installed.map((w) => (
          <Button key={w.id} variant="secondary" busy={busy === w.id} disabled={busy !== null} onClick={() => void connect(w.id)} aria-label={`Connect ${w.name}`}>
            Connect {w.name}
          </Button>
        ))}
      </div>
      <div aria-live="assertive">{error ? <Alert tone="bad" title="Could not connect">{error}</Alert> : null}</div>
    </div>
  );
}

const MY_STATUSES: ArtworkStatus[] = ['approved', 'reviewing', 'submitted', 'rejected', 'delisted'];

export function Studio() {
  const { services, state } = useMint();
  const studio = useStudio();
  const wallet = state.wallet;
  const { session, artist } = studio;
  const nameId = useId();
  const [name, setName] = useState('');
  const [payoutPick, setPayoutPick] = useState<'ordinals' | 'payment'>('ordinals');
  const [mine, setMine] = useState<StudioArtwork[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [delisting, setDelisting] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setName(artist?.displayName ?? '');
  }, [artist?.displayName, artist?.address]);

  useEffect(() => {
    if (!session) {
      setMine(null);
      return;
    }
    let alive = true;
    setListError(null);
    Promise.all(MY_STATUSES.map((status) => services.studio.listArtworks({ status, artist: session.address, page: 1, pageSize: 100 }, session.token)))
      .then((lists) => {
        if (!alive) return;
        const all = lists.flatMap((l) => l.items).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        setMine(all);
      })
      .catch((e) => alive && setListError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services, session, reloadKey]);

  const delist = async (id: string) => {
    if (!session) return;
    setDelisting(id);
    try {
      await services.studio.delist(id, session.token);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setListError(errorText(e));
    } finally {
      setDelisting(null);
    }
  };

  /** After the editions editor or the appeal form update one artwork, patch it into the list in place. */
  const patchMine = (w: StudioArtwork) => setMine((cur) => (cur ? cur.map((x) => (x.id === w.id ? w : x)) : cur));

  const candidates = wallet
    ? [
        { key: 'ordinals' as const, label: 'Ordinals address', account: wallet.ordinals },
        ...(wallet.payment.address !== wallet.ordinals.address ? [{ key: 'payment' as const, label: 'Payment address', account: wallet.payment }] : []),
      ]
    : [];
  const picked = candidates.find((c) => c.key === payoutPick) ?? candidates[0] ?? null;
  const pickedKind = picked ? payoutAddressKind(picked.account.address) : 'unknown';

  return (
    <div className="screen screen--studio">
      <ScreenHeading
        step="Artist Studio"
        title="Membership is earned by making."
        lede="Sign in with your Bitcoin wallet, prove where royalties should go, and hang a Degent by the house rules. Members mint it; the royalty rides in their funding transaction, so nobody holds your money."
      />

      {!wallet ? (
        <Panel title="1 · Connect a wallet">
          <p>The wallet is your identity here: the address that signs the challenge is the artist. No email, no password.</p>
          <WalletButtons />
        </Panel>
      ) : null}

      {wallet && !session ? (
        <Panel title="1 · Sign in with Bitcoin" kicker={`Connected: ${wallet.name}`}>
          <p>
            The studio issues a one-time challenge; your wallet signs it (BIP-322) with your ordinals address{' '}
            <Mono>{shortHash(wallet.ordinals.address, 8)}</Mono>. Nothing is spent and nothing leaves your wallet but a signature.
          </p>
          {studio.restoring ? <p className="muted" role="status">Checking your previous session…</p> : null}
          <div className="actions">
            <Button busy={studio.busy === 'sign-in'} disabled={studio.restoring} onClick={() => void studio.signIn()}>
              Sign in with Bitcoin
            </Button>
          </div>
        </Panel>
      ) : null}

      <div aria-live="assertive">{studio.error ? <Alert tone="bad" title="Studio">{studio.error}</Alert> : null}</div>

      {session && artist ? (
        <>
          <Panel title="Your profile" kicker={`Signed in as ${shortHash(session.address, 8)}`}>
            <dl className="facts facts--inline">
              <Fact label="Artist address">
                <Mono wrap>{artist.address}</Mono>
              </Fact>
              <Fact label="Member since">
                <span className="mono">{formatTimestamp(artist.joinedAt)}</span>
              </Fact>
              <Fact label="Artworks">
                <span className="mono">{artist.artworks.approved}</span> hanging · <span className="mono">{artist.artworks.total}</span> in all
              </Fact>
            </dl>
            <form
              className="field field--inline"
              onSubmit={(e) => {
                e.preventDefault();
                void studio.setDisplayName(name);
              }}
            >
              <label htmlFor={nameId} className="label">
                Display name
              </label>
              <input id={nameId} type="text" maxLength={40} value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="How the gallery names you" />
              <Button type="submit" variant="secondary" busy={studio.busy === 'profile'}>
                Save name
              </Button>
            </form>
            <div className="actions">
              <Button variant="ghost" onClick={() => studio.signOut()}>
                Sign out
              </Button>
            </div>
          </Panel>

          <Panel title="Payout address" kicker="Proven, not declared">
            {artist.payoutAddress ? (
              <p className="verified">
                <Badge tone="good">✓ Proven</Badge> Royalties go to <Mono wrap>{artist.payoutAddress}</Mono>
                {artist.payoutVerifiedAt ? <span className="small muted"> · proven {formatTimestamp(artist.payoutVerifiedAt)}</span> : null}
              </p>
            ) : (
              <Alert tone="warn" title="No payout address yet">
                Members cannot mint your Degents until you prove one: the mint needs to know where output [1] of their funding
                transaction goes.
              </Alert>
            )}
            <p>
              Pick one of your wallet’s addresses and sign the fixed text{' '}
              <Mono wrap>{payoutMessage(picked?.account.address ?? '<address>', session.address)}</Mono> with it (BIP-322 simple). A
              proof made for one artist cannot be replayed by another.
            </p>
            {wallet ? (
              <div role="radiogroup" aria-label="Payout address" className="tier-pick">
                {candidates.map((c) => {
                  const kind = payoutAddressKind(c.account.address);
                  return (
                    <label key={c.key} className={`tier-pick__opt ${payoutPick === c.key ? 'is-on' : ''}`}>
                      <input type="radio" name="payout" checked={payoutPick === c.key} onChange={() => setPayoutPick(c.key)} />
                      <span className="tier-pick__name">{c.label}</span>
                      <span className="mono small mono--wrap">{c.account.address}</span>
                      <span className="small">
                        <Badge tone={kind === 'legacy' ? 'bad' : 'brass'}>{KIND_LABEL[kind]}</Badge>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <Alert tone="info" title="Wallet disconnected">
                Reconnect a wallet to sign the proof.
              </Alert>
            )}
            {picked && pickedKind === 'legacy' ? (
              <Alert tone="bad" title="Legacy address: the studio refuses it">
                {new LegacyPayoutError(picked.account.address).message}
              </Alert>
            ) : null}
            <div className="actions">
              <Button
                busy={studio.busy === 'payout'}
                disabled={!picked || pickedKind === 'legacy' || pickedKind === 'unknown' || !wallet?.signMessage}
                onClick={() => picked && void studio.provePayout(picked.account.address)}
              >
                Prove &amp; save payout address
              </Button>
            </div>
          </Panel>

          <Panel>
            <NotifySettings />
          </Panel>

          <Panel title="Your Degents" kicker="What you have hung">
            <div className="row">
              <Link to={{ name: 'studio-upload' }} className="btn btn--primary">
                Hang a new Degent
              </Link>
              <Link to={{ name: 'studio-royalties' }} className="btn btn--secondary">
                Royalties
              </Link>
            </div>
            {listError ? <Alert tone="bad" title="Could not list your artworks">{listError}</Alert> : null}
            {mine === null && !listError ? <p className="muted" role="status">Fetching your artworks…</p> : null}
            {mine && mine.length === 0 ? <p className="muted">Nothing yet. Your first gentleman awaits.</p> : null}
            {mine && mine.length > 0 ? (
              <ul className="mine" aria-label="Your artworks">
                {mine.map((w) => (
                  <li key={w.id} className="mine__item" data-testid={`mine-${w.id}`}>
                    <Frame size="thumb" src={w.status === 'approved' ? services.studio.contentUrl(w.id) : null} alt={w.title} />
                    <div className="mine__body">
                      <p className="mine__title">
                        {w.status === 'approved' ? <Link to={{ name: 'artwork', id: w.id }}>{w.title}</Link> : w.title} <StatusPill artwork={w} />
                        <AppealBadge artwork={w} />
                      </p>
                      <p className="small muted">
                        <Mono>{w.id}</Mono> · {formatTimestamp(w.createdAt)}
                        {typeof w.mintedEditions === 'number' ? <> · {w.mintedEditions} minted</> : null}
                      </p>
                      {w.status === 'reviewing' && w.needsHuman ? (
                        <p className="small">The automated check could not decide on its own; the house will look and decide.</p>
                      ) : null}
                      {w.status === 'rejected' && w.review ? (
                        <ul className="small reasons">
                          {[...(w.review.house?.reasons ?? []), ...(w.review.automated?.reasons ?? [])].map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      ) : null}
                      {w.status === 'approved' ? <EditionsEditor artwork={w} onChanged={patchMine} /> : null}
                      {w.status === 'rejected' ? <AppealForm artwork={w} onAppealed={patchMine} /> : null}
                    </div>
                    {w.status === 'approved' ? (
                      <Button variant="danger" busy={delisting === w.id} onClick={() => void delist(w.id)} aria-label={`Delist ${w.title}`}>
                        Delist
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
