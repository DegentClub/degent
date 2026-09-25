import { useEffect, useState } from 'react';
import { useMint } from '../flow/context';
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Panel } from '../components/ui';
import { SoldOutBadge } from '../components/Editions';
import { shortHash } from '../lib/format';
import type { ArtworkList, StudioArtwork } from '../services/studioApi';
import { errorText } from '../components/ui';
import { navigate, type Route } from '../lib/router';

export function GalleryCard({ artwork, src }: { artwork: StudioArtwork; src: string }) {
  return (
    <li className="gallery__item">
      <Link to={{ name: 'artwork', id: artwork.id }} className="gallery__card" aria-label={`${artwork.title} by ${shortHash(artwork.artist, 6)}`}>
        <Frame src={src} alt={`${artwork.title}: a Degent by ${shortHash(artwork.artist, 6)}`} />
        <span className="gallery__caption">
          <span className="gallery__title">{artwork.title}</span>
          <span className="gallery__artist mono">{shortHash(artwork.artist, 6)}</span>
          {artwork.featured ? <Badge tone="brass">Featured</Badge> : null}
          <SoldOutBadge artwork={artwork} />
        </span>
      </Link>
    </li>
  );
}

/** All / mintable / sold-out (ADR-0012 `available` filter, `GET /v1/artworks?available=`). */
const AVAILABILITY: ReadonlyArray<{ key: 'all' | 'available' | 'sold-out'; label: string; available: boolean | undefined }> = [
  { key: 'all', label: 'All', available: undefined },
  { key: 'available', label: 'Available to mint', available: true },
  { key: 'sold-out', label: 'Sold out', available: false },
];

export function Gallery({ page, artist, available }: { page: number; artist: string | null; available?: boolean }) {
  const { services, app } = useMint();
  const [data, setData] = useState<ArtworkList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageSize = app.galleryPageSize;

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    services.studio
      .listArtworks({ status: 'approved', page, pageSize, ...(artist ? { artist } : {}), ...(available !== undefined ? { available } : {}) })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services, page, pageSize, artist, available]);

  const routeFor = (a: boolean | undefined): Route => ({ name: 'gallery', page: 1, artist, ...(a !== undefined ? { available: a } : {}) });
  const pageRouteFor = (p: number): Route => ({ name: 'gallery', page: p, artist, ...(available !== undefined ? { available } : {}) });

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = data ? Math.min(total, (page - 1) * pageSize + data.items.length) : 0;

  return (
    <div className="screen screen--gallery">
      <ScreenHeading
        step="The Gallery"
        title="Degents, hung by their makers."
        lede={
          <>
            Every piece here passed the house rules and is minted on demand: pick one, and the mint pays its artist a royalty
            in the very transaction you sign. {artist ? <>Showing the work of <span className="mono">{shortHash(artist, 6)}</span>. <Link to={{ name: 'gallery', page: 1, artist: null }}>All artists</Link>.</> : null}
          </>
        }
      />
      <div className="row gallery__filter" role="group" aria-label="Filter by availability">
        {AVAILABILITY.map((f) => (
          <Link
            key={f.key}
            to={routeFor(f.available)}
            className={['btn', 'btn--sm', (available === f.available ? 'btn--secondary' : 'btn--ghost')].join(' ')}
            aria-current={available === f.available ? 'true' : undefined}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {error ? <Alert tone="bad" title="The gallery could not be loaded">{error}</Alert> : null}
      {!data && !error ? <p className="muted" role="status">Fetching the walls…</p> : null}
      {data ? (
        <>
          <p className="gallery__count" role="status">
            {total === 0 ? 'Nothing hangs here yet.' : `Showing ${first}–${last} of ${total}`}
          </p>
          <ul className="gallery" aria-label="Gallery">
            {data.items.map((w) => (
              <GalleryCard key={w.id} artwork={w} src={services.studio.contentUrl(w.id)} />
            ))}
          </ul>
          {pages > 1 ? (
            <nav className="pager" aria-label="Gallery pages">
              {page > 1 ? (
                <Link to={pageRouteFor(page - 1)} className="btn btn--ghost" rel="prev">
                  Previous
                </Link>
              ) : (
                <span className="btn btn--ghost" aria-disabled="true">Previous</span>
              )}
              <span className="pager__pages">
                {Array.from({ length: pages }, (_, i) => i + 1).map((n) =>
                  n === page ? (
                    <span key={n} className="pager__page is-on" aria-current="page">
                      {n}
                    </span>
                  ) : (
                    <Link key={n} to={pageRouteFor(n)} className="pager__page" aria-label={`Page ${n}`}>
                      {n}
                    </Link>
                  ),
                )}
              </span>
              {page < pages ? (
                <Link to={pageRouteFor(page + 1)} className="btn btn--ghost" rel="next">
                  Next
                </Link>
              ) : (
                <span className="btn btn--ghost" aria-disabled="true">Next</span>
              )}
            </nav>
          ) : null}
        </>
      ) : null}
      <Panel kicker="Artists" title="Hang your own">
        <p>
          Made a gentleman by the rules? <Link to={{ name: 'studio' }}>Sign in with Bitcoin</Link>, prove a payout address and
          hang it. Members mint it; you are paid in their funding transaction, never through us.
        </p>
      </Panel>
    </div>
  );
}
