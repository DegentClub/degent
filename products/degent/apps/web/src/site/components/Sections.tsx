import type { Async } from '../context';
import { useSite } from '../context';
import type { CollectionItem, CollectionStats } from '../services/types';
import { formatCount, formatGB, formatMB, projectedBytes } from '../lib/stats';
import { provenance } from '../chrome/Meters';
import { Icon } from './Icons';
import { Cta, DegentImage, Frame, Pill, Wall } from './ui';

/** The collection card: certified numbers only; the 10K projection is labelled as a projection. */
export function CollectionCard({ stats, first }: { stats: Async<CollectionStats>; first: Pick<CollectionItem, 'id' | 'number'> | null }) {
  const { app } = useSite();
  const s = stats.status === 'ok' ? stats.value : null;
  const proj = s ? projectedBytes(s) : null;
  const na = stats.status === 'loading' ? '…' : 'unavailable';
  return (
    <section className="card collection-card" aria-labelledby="cc-title">
      <div className="collection-card__text">
        <Pill tone="dark">Ordinal collection</Pill>
        <h2 id="cc-title">Decentralized Gentlemen Club</h2>
        <p className="collection-card__line">The biggest Ordinal collection on Bitcoin, one gentleman at a time.</p>
        <ul className="statpills" data-testid="collection-stats">
          <li>
            Supply <strong>{s ? formatCount(s.supply) : '10,000'}</strong>
          </li>
          <li>
            Minted <strong data-testid="card-minted">{s ? formatCount(s.minted) : na}</strong>
          </li>
          <li>
            Blockspace <strong data-testid="card-bytes">{s ? formatMB(s.bytes) : na}</strong>
          </li>
          <li>
            Projected <strong data-testid="card-projected">{proj !== null ? `~${formatGB(proj)}` : na}</strong> at 10K
          </li>
        </ul>
        <p className="collection-card__prov small muted" data-testid="card-provenance">
          {s ? provenance(s) : stats.status === 'error' ? 'Certification unavailable: numbers are hidden rather than guessed.' : 'Loading certified stats…'}
          {proj !== null ? ' · the projection extrapolates the certified average size to 10,000 Degents.' : ''}
        </p>
        <div className="cta-row">
          <Cta to="/mint" icon={<Icon.rocket />}>
            Mint Now
          </Cta>
          <Cta href={app.social.x} variant="dark" icon={<Icon.x />}>
            Twitter
          </Cta>
          <Cta href={app.social.telegram} variant="blue" icon={<Icon.telegram />}>
            Telegram
          </Cta>
        </div>
      </div>
      <div className="collection-card__art">
        {first ? (
          <Frame plaque="DEGEN" caption={`DEGENT #${first.number}`}>
            <DegentImage item={first} eager />
          </Frame>
        ) : null}
      </div>
    </section>
  );
}

/** Noir comic cover (decorative SVG, no network). */
export function ComicCover() {
  return (
    <svg className="comic-cover" viewBox="0 0 300 400" role="img" aria-label="Comic cover: The Decentralized Gentlemen Club, a noir city at night with lightning">
      <defs>
        <linearGradient id="cc-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d1b2a" />
          <stop offset="1" stopColor="#1b263b" />
        </linearGradient>
      </defs>
      <rect width="300" height="400" fill="url(#cc-sky)" />
      <path d="M190 20 L170 110 L195 105 L160 200" stroke="#f7c948" strokeWidth="5" fill="none" strokeLinejoin="round" />
      <g fill="#050608">
        <rect x="0" y="250" width="40" height="150" />
        <rect x="35" y="210" width="45" height="190" />
        <rect x="80" y="270" width="30" height="130" />
        <rect x="105" y="190" width="50" height="210" />
        <rect x="150" y="240" width="35" height="160" />
        <rect x="185" y="200" width="55" height="200" />
        <rect x="240" y="260" width="60" height="140" />
      </g>
      <g fill="#f7c948" opacity=".7">
        <rect x="45" y="230" width="5" height="7" />
        <rect x="60" y="260" width="5" height="7" />
        <rect x="115" y="215" width="5" height="7" />
        <rect x="130" y="250" width="5" height="7" />
        <rect x="200" y="225" width="5" height="7" />
        <rect x="220" y="280" width="5" height="7" />
      </g>
      <ellipse cx="150" cy="330" rx="46" ry="36" fill="#5fae4e" />
      <circle cx="132" cy="306" r="11" fill="#fff" />
      <circle cx="168" cy="306" r="11" fill="#fff" />
      <circle cx="134" cy="308" r="5" fill="#111" />
      <circle cx="170" cy="308" r="5" fill="#111" />
      <path d="M150 368 L134 360 L134 376 Z M150 368 L166 360 L166 376 Z" fill="#2efc86" />
      <path d="M205 300 l20 -30 l20 30 z" fill="none" stroke="#e8e8e8" strokeWidth="3" />
      <path d="M225 300 v28" stroke="#e8e8e8" strokeWidth="3" />
      <text x="150" y="48" textAnchor="middle" fill="#fff" fontFamily="Space Grotesk, system-ui, sans-serif" fontWeight="700" fontSize="19">THE DECENTRALIZED</text>
      <text x="150" y="72" textAnchor="middle" fill="#2efc86" fontFamily="Space Grotesk, system-ui, sans-serif" fontWeight="700" fontSize="19">GENTLEMEN CLUB</text>
    </svg>
  );
}

export function ordiscanUrl(id: string): string {
  return `https://ordiscan.com/inscription/${id}`;
}

/** "This is Gentlemen- The Comic" teaser. */
export function ComicTeaser({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const { app } = useSite();
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="card comic-teaser" aria-labelledby="comic-teaser-h">
      <div className="comic-teaser__text">
        <Pill>The Comic</Pill>
        <H id="comic-teaser-h">This is Gentlemen- The Comic</H>
        <span className="rule" aria-hidden="true" />
        <p>Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History.</p>
        <div className="cta-row">
          <Cta to="/comic">Read the Comic</Cta>
          {app.comicInscriptionId ? (
            <Cta href={ordiscanUrl(app.comicInscriptionId)} variant="dark">
              View in Ordiscan
            </Cta>
          ) : (
            <Cta to="/mint" variant="dark" icon={<Icon.rocket />}>
              Mint Now
            </Cta>
          )}
        </div>
      </div>
      <div className="comic-teaser__art">
        <ComicCover />
      </div>
    </section>
  );
}

/** "Full Block Exhibit" teaser: the museum rung of the learning ladder. */
export function ExhibitTeaser({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="card exhibit-teaser" aria-labelledby="exhibit-teaser-h" data-testid="exhibit-teaser">
      <div className="exhibit-teaser__text">
        <Pill tone="gold">The Exhibit</Pill>
        <H id="exhibit-teaser-h">A gentleman the size of a block</H>
        <span className="rule" aria-hidden="true" />
        <p>
          A Full Block Degent is one artwork that fills nearly a whole Bitcoin block — ~3.9M of the 4,000,000 weight
          units the chain allows. See it as a museum object, drawn to scale.
        </p>
        <div className="cta-row">
          <Cta to="/exhibit" icon={<Icon.block />}>Enter the Exhibit</Cta>
          <Cta to="/exhibit?kiosk=1" variant="dark">Kiosk mode</Cta>
        </div>
      </div>
      <div className="exhibit-teaser__viz" aria-hidden="true">
        <div className="exhibit-teaser__bar">
          <span className="exhibit-teaser__fill" style={{ width: '99%' }} />
          <span className="exhibit-teaser__cap">4,000,000 WU</span>
        </div>
      </div>
    </section>
  );
}

/** "Degen Minter" banner over the grid wall. */
export function MinterBanner({ wall }: { wall: Array<Pick<CollectionItem, 'id' | 'number'>> }) {
  return (
    <section className="minter-banner" aria-labelledby="minter-h">
      <Wall items={wall} count={12} />
      <div className="minter-banner__shade" aria-hidden="true" />
      <div className="minter-banner__content">
        <h2 id="minter-h">Degen Minter</h2>
        <p>Create Bitcoin Ordinals Inscriptions.</p>
        <div className="cta-row cta-row--center">
          <Cta to="/mint" icon={<Icon.rocket />}>
            Mint Now!
          </Cta>
          <Cta to="/how-it-works" variant="dark">
            Learn How
          </Cta>
        </div>
      </div>
    </section>
  );
}
