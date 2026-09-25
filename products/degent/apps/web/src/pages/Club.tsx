/**
 * `/club`: the holders' area. Sign in with Bitcoin (the mint's SIWB challenge, BIP-322 by the wallet: the same
 * session as /review), then "your Degents" from the Register (`/v1/register/holder/{address}`), the members'
 * review queue and the holders-only Telegram gate (/verify). Perks: TODO(copy).
 */
import { useEffect, useState } from 'react';
import type { RegisterMember } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { Alert, Badge, Button, ExternalLink, Mono, Panel, errorText } from '../components/ui';
import { NotAHolderError, signInAsHolder, type HolderSession } from '../lib/holderSession';
import { CtaLink, GoldFrame, SiteLink, useDocumentMeta } from '../site/components';
import type { WalletId } from '../services/types';
import { MintCta, useMintMode } from '../site/mintMode';

const SHOW = 24;

export function Club() {
  const { services, app } = useMint();
  const [session, setSession] = useState<HolderSession | null>(null);
  const [notHolder, setNotHolder] = useState<string | null>(null);
  const [busy, setBusy] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<number[] | null>(null);
  const [members, setMembers] = useState<RegisterMember[]>([]);
  // Read-only mint (no sign-in): look holdings up by address instead (public Register read).
  const { readonly } = useMintMode();
  const [lookup, setLookup] = useState('');
  const [looked, setLooked] = useState<string | null>(null);
  const holderAddress = session?.address ?? looked;
  useDocumentMeta({ title: 'The Club · degent.club', description: 'The holders’ area of the Decentralized Gentlemen Club.' });

  useEffect(() => {
    if (!holderAddress) return;
    let alive = true;
    setNumbers(null);
    setMembers([]);
    (async () => {
      try {
        const h = await services.mintApi.getHolder(holderAddress);
        if (!alive) return;
        setNumbers(h.degents);
        const list = await Promise.all(h.degents.slice(0, SHOW).map((n) => services.mintApi.getRegisterMember(n).catch(() => null)));
        if (alive) setMembers(list.filter((m): m is RegisterMember => m !== null));
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [holderAddress, services]);

  const signIn = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    setNotHolder(null);
    try {
      setSession(await signInAsHolder(services, id, app.network));
    } catch (e) {
      if (e instanceof NotAHolderError) setNotHolder(e.address);
      else setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <p className="badge-pill">Members</p>
        <h1 tabIndex={-1}>The Club</h1>
        <p className="lede">Sign in with the wallet that holds your Degent: one signed message, no transaction, no fees.</p>
      </div>

      {readonly ? (
        <>
          <Panel title="Look up a wallet" kicker="Read-only">
            <p>Sign-in opens with minting. Meanwhile, paste an ordinals (taproot) address to see the Degents the Register shows there.</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                const a = lookup.trim();
                setError(null);
                if (!/^(bc1p|tb1p|bcrt1p)[02-9ac-hj-np-z]{20,90}$/.test(a)) {
                  setError('That does not look like a taproot (ordinals) address.');
                  return;
                }
                setLooked(a);
              }}
            >
              <label className="sr-only" htmlFor="club-lookup">
                Ordinals address
              </label>
              <input id="club-lookup" className="input mono" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="bc1p…" autoComplete="off" spellCheck={false} />
              <Button type="submit">Look up</Button>
            </form>
            <div aria-live="polite">{error ? <Alert tone="bad" title="Could not look that up">{error}</Alert> : null}</div>
          </Panel>
          {looked ? (
            <section aria-labelledby="yours-title">
              <h2 id="yours-title">Degents at this address {numbers ? <Badge tone="good">{numbers.length}</Badge> : null}</h2>
              <p className="small">
                <Mono wrap>{looked}</Mono>
              </p>
              {numbers === null ? (
                <p className="muted" role="status">
                  Reading the Register…
                </p>
              ) : numbers.length === 0 ? (
                <p>The Register shows no Degent at this address right now.</p>
              ) : (
                <ul className="frame-grid frame-grid--compact" aria-label="Degents at this address">
                  {members.map((m) => (
                    <li key={m.n}>
                      <SiteLink to={`/collection/${m.n}`} className="frame-card" aria-label={`Degent #${m.n}`}>
                        <GoldFrame src={m.contentUrl} alt={`Degent #${m.n}`} size="sm" />
                        <span className="frame-card__caption mono">DEGENT #{m.n}</span>
                      </SiteLink>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          <Panel title="Join the club" kicker="Members decide">
            <p>New Degents join by the members’ vote once minting opens.</p>
            <MintCta>Mint a Degent</MintCta>
          </Panel>
        </>
      ) : !session ? (
        <Panel title="Sign in with Bitcoin">
          <ul className="wallets" aria-label="Wallets">
            {services.wallets.list().map((w) => (
              <li key={w.id} className={`wallet ${w.installed ? '' : 'wallet--missing'}`}>
                <span className="wallet__name">{w.name}</span>
                {w.installed ? (
                  <Button busy={busy === w.id} disabled={busy !== null} onClick={() => void signIn(w.id)} aria-label={`Sign in to the club with ${w.name}`}>
                    Sign in
                  </Button>
                ) : (
                  <ExternalLink href={w.installUrl}>Install {w.name}</ExternalLink>
                )}
              </li>
            ))}
          </ul>
          <div aria-live="polite">
            {notHolder ? (
              <Alert tone="warn" title="No Degent at this address yet">
                <Mono wrap>{notHolder}</Mono> holds no Degent. <SiteLink to="/mint">Mint one</SiteLink> and the members will review it.
              </Alert>
            ) : null}
            {error ? <Alert tone="bad" title="Could not sign in">{error}</Alert> : null}
          </div>
        </Panel>
      ) : (
        <>
          <Panel title="Welcome back, gentleman." kicker="Signed in">
            <p className="small">
              <Mono wrap>{session.address}</Mono>
            </p>
          </Panel>

          <section aria-labelledby="yours-title">
            <h2 id="yours-title">Your Degents {numbers ? <Badge tone="good">{numbers.length}</Badge> : null}</h2>
            {numbers === null ? (
              <p className="muted" role="status">
                Reading the Register…
              </p>
            ) : numbers.length === 0 ? (
              <p>The Register shows no Degent at this address right now.</p>
            ) : (
              <ul className="frame-grid frame-grid--compact" aria-label="Your Degents">
                {members.map((m) => (
                  <li key={m.n}>
                    <SiteLink to={`/collection/${m.n}`} className="frame-card" aria-label={`Degent #${m.n}`}>
                      <GoldFrame src={m.contentUrl} alt={`Degent #${m.n}`} size="sm" />
                      <span className="frame-card__caption mono">DEGENT #{m.n}</span>
                    </SiteLink>
                  </li>
                ))}
              </ul>
            )}
            {numbers && numbers.length > SHOW ? <p className="small muted">Showing the first {SHOW} of {numbers.length}.</p> : null}
          </section>

          <div className="two-col">
            <Panel title="Review new Degents" kicker="Members decide">
              <p>Every new Degent joins by the members’ vote. Look at the candidates and sign your vote.</p>
              <CtaLink to="/review">Open the review</CtaLink>
            </Panel>
            <Panel title="The holders’ Telegram" kicker="Gated">
              <p>
                Start the club bot in Telegram: it sends you a personal <span className="mono">/verify</span> link, where you sign once
                to prove you hold a Degent and receive a single-use invite.
              </p>
              {app.socials.telegram ? <ExternalLink href={app.socials.telegram}>Open the club on Telegram</ExternalLink> : null}{' '}
              <SiteLink to="/verify">About /verify</SiteLink>
            </Panel>
          </div>

          <Panel title="Perks" kicker="Member-only benefits">
            <p className="todo-copy">TODO(copy): the member perks, as the club announces them.</p>
          </Panel>
        </>
      )}
    </div>
  );
}
