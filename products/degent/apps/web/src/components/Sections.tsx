/** Page sections shared by Home, The Collection and the Comic (site spec "Collection page"). */
import { useEffect, useState, type ReactNode } from 'react';
import { useMint } from '../flow/context';
import { useSite } from '../flow/site';
import { PROJECTED_TARGET, formatGB, formatMB } from '../lib/counts';
import { formatTimestamp, groupDigits, shortHash } from '../lib/format';
import { COPY, SOCIAL } from '../lib/site';
import type { CertifiedItem } from '../services/certifyApi';
import { Frame } from './Frame';
import { Icon } from './Icons';
import { Link } from './Link';
import { Tag } from './Meters';
import { Alert } from './ui';

/** Hero over a darkened wall of framed Degents (the first certified members). */
export function PageHero({ pill, title, sub, children, wall = true }: { pill: string; title: ReactNode; sub?: ReactNode; children?: ReactNode; wall?: boolean }) {
  const { members } = useSite();
  const { services } = useMint();
  const [tiles, setTiles] = useState<CertifiedItem[]>(() => members.peek(0, 18) ?? []);
  useEffect(() => {
    if (!wall) return;
    let alive = true;
    members
      .load(0, 18)
      .then((t) => alive && setTiles(t))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [members, wall]);
  return (
    <section className="page-hero">
      {wall ? (
        <div className="page-hero__wall" aria-hidden="true">
          {tiles.map((t) => (
            <span key={t.inscriptionId} className="page-hero__tile">
              <img src={services.ord.contentUrl(t.inscriptionId)} alt="" loading="lazy" decoding="async" />
            </span>
          ))}
        </div>
      ) : null}
      <div className="page-hero__body">
        <span className="pill-badge">{pill}</span>
        <h1 tabIndex={-1} className="page-hero__title">
          {title}
        </h1>
        <span className="rule" aria-hidden="true" />
        {sub ? <p className="page-hero__sub">{sub}</p> : null}
        {children ? <div className="row page-hero__cta">{children}</div> : null}
      </div>
    </section>
  );
}

/** A marked placeholder for copy the live site had but the capture did not (never invented). */
export function TodoCopy({ children }: { children: ReactNode }) {
  return (
    <div className="todo-copy" role="note">
      <p className="todo-copy__tag mono">TODO(copy)</p>
      <div>{children}</div>
    </div>
  );
}

function StatPill({ k, v, tags }: { k: string; v: ReactNode; tags?: ReactNode }) {
  return (
    <li className="stat" data-testid={`stat-${k.toLowerCase()}`}>
      <span className="stat__k">{k}:</span> <span className="stat__v mono">{v}</span>
      {tags}
    </li>
  );
}

/** The collection card: stats computed from the attestation, projected vs certified explicit. */
export function CollectionCard({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const { certificate, demo, slug, members } = useSite();
  const { services } = useMint();
  const [first, setFirst] = useState<CertifiedItem | null>(() => members.peek(0, 1)?.[0] ?? null);
  useEffect(() => {
    let alive = true;
    members
      .load(0, 1)
      .then((t) => alive && setFirst(t[0] ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [members]);
  const H = `h${headingLevel}` as 'h2';
  const c = certificate.status === 'ready' ? certificate.counts : null;
  const certTag = <Tag kind={demo ? 'demo' : 'certified'} />;

  return (
    <section className="collection-card" aria-labelledby="collection-card-title" data-testid="collection-card">
      <div className="collection-card__body">
        <span className="pill-badge pill-badge--solid">{COPY.cardBadge}</span>
        <H id="collection-card-title" className="collection-card__title">
          {c?.name ?? COPY.cardTitle}
        </H>
        <p className="collection-card__line">
          {COPY.cardLine}{' '}
          <span className="collection-card__target" data-testid="projection">
            Target: 10K = 3+ GB of blockspace <Tag kind="projected" />
          </span>
        </p>
        <ul className="stats" aria-label="Collection stats">
          <StatPill k="Supply" v={groupDigits(PROJECTED_TARGET.supply)} tags={<Tag kind="projected" />} />
          <StatPill k="Minted" v={c ? groupDigits(c.minted) : '—'} tags={c ? certTag : null} />
          <StatPill
            k="Blockspace"
            v={c ? formatMB(c.bytes) : '—'}
            tags={
              c ? (
                <>
                  {certTag}
                  <span className="stat__of">
                    {' '}
                    of <span className="mono">{formatGB(PROJECTED_TARGET.blockspaceBytes)}</span> <Tag kind="projected" />
                  </span>
                </>
              ) : null
            }
          />
          <StatPill k="Slug" v={c?.slug ?? slug} />
        </ul>
        {certificate.status === 'ready' ? (
          <p className="certline small" data-testid="certline">
            {demo ? (
              <>
                <strong>Demo data:</strong> a simulated block.space attestation, not the real certificate.{' '}
              </>
            ) : (
              <>Certified by block.space </>
            )}
            at block <span className="mono">{groupDigits(certificate.counts.asOfBlockHeight)}</span> · issued{' '}
            <span className="mono">{formatTimestamp(certificate.counts.issuedAt)}</span> · {certificate.counts.method} · key{' '}
            <span className="mono">{certificate.data.attestation.keyId}</span>
            {certificate.counts.excluded > 0 ? <> · {groupDigits(certificate.counts.excluded)} considered and excluded</> : null}
            {certificate.counts.manifestVerified === false ? <> · the legacy manifest is not inscribed under the parent yet, so its items do not count</> : null}
          </p>
        ) : null}
        {c?.studio ? (
          <p className="certline small" data-testid="studio-line">
            Open Studio: <span className="mono">{groupDigits(c.studio.mints)}</span> certified mints by{' '}
            <span className="mono">{c.studio.artists}</span> artist{c.studio.artists === 1 ? '' : 's'} across{' '}
            <span className="mono">{c.studio.artworks}</span> artwork{c.studio.artworks === 1 ? '' : 's'}
            {certificate.status === 'ready' && certificate.data.attestation.stats.attribution?.royaltiesVerified ? (
              <>
                {' '}
                · <span className="mono">{certificate.data.attestation.stats.attribution.royaltiesVerified}</span> artist royalties verified on chain
              </>
            ) : null}
            .
          </p>
        ) : null}
        {certificate.status === 'loading' ? (
          <p className="certline small muted" role="status">
            Reading the block.space certificate…
          </p>
        ) : null}
        {certificate.status === 'error' ? (
          <Alert tone="warn" title="The block.space certificate is unavailable">
            No counts are shown rather than guessed. <span className="small muted">({certificate.error})</span>
          </Alert>
        ) : null}
        <div className="row">
          <Link to={{ name: 'home' }} className="btn btn--primary btn--sm">
            Website
          </Link>
          <a className="btn btn--dark btn--sm" href={SOCIAL.x} target="_blank" rel="noopener noreferrer">
            <Icon.X /> Twitter<span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a className="btn btn--telegram btn--sm" href={SOCIAL.telegram} target="_blank" rel="noopener noreferrer">
            <Icon.Telegram /> Telegram<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <div className="collection-card__art">
        <Frame
          size="large"
          src={first ? services.ord.contentUrl(first.inscriptionId) : null}
          alt={first ? `DEGENT #1, inscription ${groupDigits(first.number)}${first ? ` (${shortHash(first.inscriptionId, 6)})` : ''}` : 'DEGENT #1'}
          plaque="DEGEN"
        />
      </div>
    </section>
  );
}

/** "This is Gentlemen- The Comic" (site spec §5). The comic's inscription id is config, not invented. */
export function ComicSection({ headingLevel = 2 }: { headingLevel?: 1 | 2 }) {
  const { app, services } = useMint();
  const id = app.comicInscriptionId;
  const H = `h${headingLevel}` as 'h2';
  return (
    <section className="comic" aria-labelledby="comic-title">
      <div className="comic__body">
        <span className="pill-badge">The Comic</span>
        <H id="comic-title" className="comic__title" tabIndex={headingLevel === 1 ? -1 : undefined}>
          {COPY.comicTitle}
        </H>
        <p className="lede">{COPY.comicText}</p>
        <div className="row">
          <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary">
            <Icon.Rocket /> Mint Now
          </Link>
          {id ? (
            <a className="btn btn--dark" href={`https://ordiscan.com/inscription/${id}`} target="_blank" rel="noopener noreferrer">
              View in Ordiscan<span className="sr-only"> (opens in a new tab)</span> <Icon.External />
            </a>
          ) : (
            <span className="btn btn--dark" aria-disabled="true" title="TODO(copy): the comic's inscription id was not captured">
              View in Ordiscan
            </span>
          )}
        </div>
        {id ? (
          <p className="small muted">
            On chain: <a href={services.ord.inscriptionUrl(id)} target="_blank" rel="noopener noreferrer" className="mono">{shortHash(id, 8)}</a>
          </p>
        ) : null}
      </div>
      <div className="comic__art">
        {id ? (
          <Frame size="large" src={services.ord.contentUrl(id)} alt="The Decentralized Gentlemen Club comic, cover (from the chain)" plaque="THE COMIC" />
        ) : (
          <Frame size="large" src={null} alt="Cover art placeholder: THE DECENTRALIZED GENTLEMEN CLUB (the comic's inscription is not configured)" plaque="THE COMIC" />
        )}
      </div>
    </section>
  );
}

/** "Degen Minter" banner (site spec §6). */
export function MinterBanner() {
  return (
    <section className="minter-banner" aria-labelledby="minter-title">
      <h2 id="minter-title">{COPY.minterTitle}</h2>
      <p>{COPY.minterText}</p>
      <div className="row">
        <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary">
          Mint Now!
        </Link>
        <Link to={{ name: 'mint-process' }} className="btn btn--dark">
          Learn How
        </Link>
      </div>
    </section>
  );
}
