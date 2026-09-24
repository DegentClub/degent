/**
 * `/` Home: hero over the wall of framed Degents, certified stats and the live mint meters (one source:
 * /v1/stats), the comic teaser, the latest mints (/v1/explorer) and the Degen Minter call to action.
 */
import { useEffect, useState } from 'react';
import { CHARTER_SIZE, type RegisterMember } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { groupDigits } from '../lib/format';
import { ResumeBanner } from '../components/ResumeBanner';
import { CtaLink, ExternalButton, GoldFrame, MintMeters, Pill, SiteLink, useDocumentMeta } from '../site/components';
import { PROJECTED_CHARTER_BYTES, useSite } from '../site/data';

export function useLatest(limit: number): { items: RegisterMember[] | null; error: string | null } {
  const { services } = useMint();
  const [items, setItems] = useState<RegisterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    services.mintApi
      .getExplorer({ offset: 0, limit, sort: 'n', order: 'desc' })
      .then((p) => alive && setItems(p.items))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [services, limit]);
  return { items, error };
}

/** The darkened wall of framed Degents behind a hero. Decorative. */
export function HeroWall({ items }: { items: RegisterMember[] | null }) {
  return (
    <div className="hero-wall" aria-hidden="true">
      {(items ?? []).slice(0, 18).map((m) => (
        <img key={m.n} src={m.contentUrl} alt="" loading="lazy" />
      ))}
    </div>
  );
}

/** Certified numbers (the Register) next to the projection, never mixed up. */
export function CertifiedStats() {
  const { stats, statsError } = useSite();
  const mb = stats ? Math.round(stats.totalBytes / 1_000_000) : null;
  return (
    <section className="card collection-card" aria-labelledby="stats-title">
      <p className="badge-pill">Ordinal collection</p>
      <h2 id="stats-title">Decentralized Gentlemen Club</h2>
      <p>The BIGGEST Ordinal collection on Bitcoin!</p>
      <ul className="stat-pills" aria-label="Collection facts">
        <li>
          Supply: <span className="mono">{groupDigits(stats?.charter ?? CHARTER_SIZE)}</span>
        </li>
        <li>
          Minted: <span className="mono" data-testid="stat-minted">{stats ? groupDigits(stats.minted) : '—'}</span>
        </li>
        <li>
          Blockspace: <span className="mono">{mb !== null ? `${groupDigits(mb)}MB` : '—'}</span> <span className="small muted">certified</span>
        </li>
        <li>
          At 10K: <span className="mono">{(PROJECTED_CHARTER_BYTES / 1e9).toFixed(0)}+ GB</span> <span className="small muted">projected</span>
        </li>
      </ul>
      <MintMeters />
      <p className="small muted">
        Counted by the Register from the chain (<span className="mono">/v1/stats</span>)
        {stats ? ` · updated ${new Date(stats.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. The 3 GB for 10,000 Degents is a projection, not a measurement.
        {statsError && !stats ? ` The Register is unreachable right now (${statsError}).` : ''}
      </p>
    </section>
  );
}

export function ComicTeaser() {
  const { app } = useMint();
  return (
    <section className="card comic-teaser" aria-labelledby="comic-title">
      <div>
        <p className="badge-pill">The lore</p>
        <h2 id="comic-title">This is Gentlemen- The Comic</h2>
        <p>Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History.</p>
        <div className="row">
          <CtaLink to="/comic">Read the comic</CtaLink>
          <CtaLink to="/mint" variant="dark">
            Mint Now
          </CtaLink>
          {app.comicInscriptionId ? <ExternalButton href={`https://ordiscan.com/inscription/${app.comicInscriptionId}`}>View in Ordiscan</ExternalButton> : null}
        </div>
      </div>
      <div className="comic-teaser__cover" aria-hidden="true">
        <span>THE DECENTRALIZED GENTLEMEN CLUB</span>
      </div>
    </section>
  );
}

export function Home() {
  const latest = useLatest(18);
  useDocumentMeta({
    title: 'degent.club · Decentralized Gentlemen Club',
    description: "Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard on-chain.",
  });
  return (
    <div className="page">
      <section className="hero-block">
        <HeroWall items={latest.items} />
        <div className="hero-block__content">
          <Pill>Degens</Pill>
          <h1 tabIndex={-1}>Decentralized Gentlemen Club</h1>
          <span className="green-rule" aria-hidden="true" />
          <p className="lede">
            Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard
            on-chain.
          </p>
          <div className="row">
            <CtaLink to="/mint">Mint Now</CtaLink>
            <CtaLink to="/how-it-works" variant="dark">
              Learn How
            </CtaLink>
          </div>
        </div>
      </section>

      <ResumeBanner goTo={(id) => `/track/${id}`} />

      <CertifiedStats />

      <ComicTeaser />

      <section aria-labelledby="latest-title">
        <div className="section-head">
          <h2 id="latest-title">Latest mints</h2>
          <SiteLink to="/collection">See the whole collection</SiteLink>
        </div>
        {latest.error ? <p className="muted">The Register is unreachable right now.</p> : null}
        <ul className="frame-grid frame-grid--compact" aria-label="Latest Degents">
          {(latest.items ?? []).slice(0, 6).map((m) => (
            <li key={m.n}>
              <SiteLink to={`/collection/${m.n}`} className="frame-card" aria-label={`Degent #${m.n}`}>
                <GoldFrame src={m.contentUrl} alt={`Degent #${m.n}`} size="sm" />
                <span className="frame-card__caption mono">DEGENT #{m.n}</span>
              </SiteLink>
            </li>
          ))}
        </ul>
      </section>

      <section className="cta-banner" aria-labelledby="minter-title">
        <HeroWall items={latest.items} />
        <div className="cta-banner__content">
          <h2 id="minter-title">Degen Minter</h2>
          <p>Create Bitcoin Ordinals Inscriptions.</p>
          <div className="row">
            <CtaLink to="/mint">Mint Now!</CtaLink>
            <CtaLink to="/how-it-works" variant="dark">
              Learn How
            </CtaLink>
          </div>
        </div>
      </section>
    </div>
  );
}
