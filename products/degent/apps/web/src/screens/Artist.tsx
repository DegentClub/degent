/**
 * `#/artists/:address`: one artist, joined from three sources:
 *   1. the studio's public profile (`GET /v1/artists/{address}`: display name; optional),
 *   2. their certified members from block.space (`GET /v1/collections/{slug}/artists/{address}`),
 *   3. their approved Studio artworks (`GET /v1/artworks?status=approved&artist=`).
 * Each source may be missing; the page says which and still shows the others.
 */
import { useEffect, useState } from 'react';
import { useMint } from '../flow/context';
import { useSite } from '../flow/site';
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { Tag } from '../components/Meters';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Button, Mono, errorText } from '../components/ui';
import { formatSats, formatTimestamp, groupDigits, shortHash } from '../lib/format';
import { CertifyApiError, verifiedRoyaltyOf, type ArtistItemsPage, type CertifiedItem } from '../services/certifyApi';
import type { StudioArtwork, StudioPublicArtist } from '../services/studioApi';
import { GalleryCard } from './Gallery';

type Load<T> = { status: 'loading' } | { status: 'ok'; value: T } | { status: 'none' } | { status: 'error'; error: string };

const PAGE = 48;

export function ArtistPage({ address }: { address: string }) {
  const { services } = useMint();
  const { slug, demo } = useSite();
  const [profile, setProfile] = useState<Load<StudioPublicArtist>>({ status: 'loading' });
  const [certified, setCertified] = useState<Load<{ head: ArtistItemsPage; items: CertifiedItem[]; next: string | null }>>({ status: 'loading' });
  const [artworks, setArtworks] = useState<Load<StudioArtwork[]>>({ status: 'loading' });
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setProfile({ status: 'loading' });
    setCertified({ status: 'loading' });
    setArtworks({ status: 'loading' });
    services.studio.getArtist(address).then(
      (value) => alive && setProfile({ status: 'ok', value }),
      () => alive && setProfile({ status: 'none' }),
    );
    services.certify.listArtistItems(slug, address, { limit: PAGE }).then(
      (head) => alive && setCertified({ status: 'ok', value: { head, items: head.items, next: head.nextCursor } }),
      (e) =>
        alive &&
        setCertified(e instanceof CertifyApiError && e.code === 'artist_not_found' ? { status: 'none' } : { status: 'error', error: errorText(e) }),
    );
    services.studio.listArtworks({ status: 'approved', artist: address, page: 1, pageSize: 48 }).then(
      (list) => alive && setArtworks({ status: 'ok', value: list.items }),
      (e) => alive && setArtworks({ status: 'error', error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [services, slug, address]);

  const loadMore = async () => {
    if (certified.status !== 'ok' || !certified.value.next) return;
    setMore(true);
    try {
      const page = await services.certify.listArtistItems(slug, address, { cursor: certified.value.next, limit: PAGE });
      setCertified({ status: 'ok', value: { head: certified.value.head, items: [...certified.value.items, ...page.items], next: page.nextCursor } });
    } catch (e) {
      setCertified({ status: 'error', error: errorText(e) });
    } finally {
      setMore(false);
    }
  };

  const name = profile.status === 'ok' && profile.value.displayName ? profile.value.displayName : null;
  const titles = new Map((artworks.status === 'ok' ? artworks.value : []).map((w) => [w.id, w.title]));
  const head = certified.status === 'ok' ? certified.value.head : null;

  return (
    <div className="screen screen--site screen--artist">
      <p className="crumbs">
        <Link to={{ name: 'gallery', page: 1, artist: null }}>← Gallery</Link>
      </p>
      <ScreenHeading
        step="Artist"
        title={name ?? shortHash(address, 8)}
        lede={
          <>
            <Mono wrap>{address}</Mono>
            {profile.status === 'ok' ? (
              <span className="small muted"> · in the studio since {formatTimestamp(profile.value.joinedAt).slice(0, 10)}</span>
            ) : profile.status === 'none' ? (
              <span className="small muted"> · no public studio profile</span>
            ) : null}
          </>
        }
      />

      <dl className="statrow" aria-label="Artist summary">
        <div>
          <dt>Certified Degents</dt>
          <dd data-testid="artist-certified">
            <span className="mono">{head ? groupDigits(head.itemCount) : certified.status === 'none' ? '0' : '—'}</span> <Tag kind={demo ? 'demo' : 'certified'} />
          </dd>
        </div>
        <div>
          <dt>Artworks minted</dt>
          <dd className="mono">{head ? groupDigits(head.artworks) : certified.status === 'none' ? '0' : '—'}</dd>
        </div>
        <div>
          <dt>In the gallery</dt>
          <dd className="mono" data-testid="artist-hanging">
            {artworks.status === 'ok' ? groupDigits(artworks.value.length) : '—'}
          </dd>
        </div>
        {head?.royaltiesVerified ? (
          <div>
            <dt>Royalties verified on chain</dt>
            <dd>
              <span className="mono">{head.royaltiesVerified}</span> · <span className="mono">{formatSats(head.royaltySats ?? 0)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <section aria-labelledby="artist-certified-title">
        <h2 id="artist-certified-title" className="section-title">
          Certified in the collection
        </h2>
        <p className="small muted">
          Membership is proven by the collection's parent inscription and certified by block.space; the attribution to this
          artist is what the minting service wrote in each inscription's metadata.
        </p>
        {certified.status === 'none' ? <p className="muted">No certified Degent is attributed to this address yet.</p> : null}
        {certified.status === 'error' ? <Alert tone="warn" title="block.space could not list this artist">{certified.error}</Alert> : null}
        {certified.status === 'ok' ? (
          <>
            <ul className="degent-grid degent-grid--wide" aria-label="Certified Degents by this artist">
              {certified.value.items.map((it) => {
                const royalty = verifiedRoyaltyOf(it);
                const title = it.attribution ? titles.get(it.attribution.artwork) ?? it.attribution.artwork : 'Degent';
                return (
                  <li key={it.inscriptionId} className="artist-item">
                    <a className="degent-tile" href={services.ord.inscriptionUrl(it.inscriptionId)} target="_blank" rel="noopener noreferrer">
                      <Frame src={services.ord.contentUrl(it.inscriptionId)} alt={`${title}, inscription ${groupDigits(it.number)}`} plaque={`#${groupDigits(it.number)}`} />
                      <span className="sr-only"> (opens on the ord explorer in a new tab)</span>
                    </a>
                    <p className="artist-item__cap small">
                      <strong>{title}</strong>
                      {typeof it.attribution?.edition === 'number' ? <> · edition {it.attribution.edition}</> : null}
                      {royalty ? <> · royalty {formatSats(royalty.sats)} verified</> : null}
                    </p>
                  </li>
                );
              })}
            </ul>
            {certified.value.next ? (
              <Button variant="secondary" busy={more} onClick={() => void loadMore()}>
                Show more
              </Button>
            ) : null}
          </>
        ) : null}
      </section>

      <section aria-labelledby="artist-gallery-title">
        <h2 id="artist-gallery-title" className="section-title">
          Hanging in the Studio gallery
        </h2>
        {artworks.status === 'error' ? <Alert tone="warn" title="The studio could not be reached">{artworks.error}</Alert> : null}
        {artworks.status === 'ok' && artworks.value.length === 0 ? <p className="muted">Nothing of theirs hangs in the gallery right now.</p> : null}
        {artworks.status === 'ok' && artworks.value.length > 0 ? (
          <ul className="gallery" aria-label="Studio artworks by this artist">
            {artworks.value.map((w) => (
              <GalleryCard key={w.id} artwork={w} src={services.studio.contentUrl(w.id)} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
