import { useEffect, useState } from 'react';
import { tierForSize, TIER_LABELS } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { Frame } from '../components/Frame';
import { Link } from '../components/Link';
import { RulesPills } from '../components/RulesPills';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, Fact, Mono, Panel, errorText } from '../components/ui';
import { navigate } from '../lib/router';
import { formatBytesExact, formatSize, formatTimestamp, shortHash } from '../lib/format';
import type { StudioArtwork, StudioPublicArtist } from '../services/studioApi';

export function ArtworkPage({ id }: { id: string }) {
  const { services, state, dispatch } = useMint();
  const [artwork, setArtwork] = useState<StudioArtwork | null>(null);
  const [artist, setArtist] = useState<StudioPublicArtist | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setArtwork(null);
    setArtist(null);
    setError(null);
    services.studio
      .getArtwork(id)
      .then(async (w) => {
        if (!alive) return;
        setArtwork(w);
        try {
          const a = await services.studio.getArtist(w.artist);
          if (alive) setArtist(a);
        } catch {
          /* the public profile is optional */
        }
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services, id]);

  const tier = artwork && state.config ? tierForSize(artwork.contentLength, state.config) : null;
  const editions = artwork && typeof artwork.mintedEditions === 'number' ? artwork.mintedEditions : null;
  const mintable = artwork?.status === 'approved';

  const mint = () => {
    if (!artwork) return;
    dispatch({ type: 'STUDIO_ARTWORK_SELECTED', artwork });
    navigate({ name: 'mint', artworkId: artwork.id });
  };

  return (
    <div className="screen screen--artwork">
      <p className="crumbs">
        <Link to={{ name: 'gallery', page: 1, artist: null }}>← Gallery</Link>
      </p>
      {error ? <Alert tone="bad" title="This Degent could not be found">{error}</Alert> : null}
      {!artwork && !error ? <p className="muted" role="status">Fetching the piece…</p> : null}
      {artwork ? (
        <>
          <ScreenHeading
            step={artwork.featured ? 'Featured Degent' : 'Degent'}
            title={artwork.title}
            lede={artwork.description ?? undefined}
          />
          <div className="artwork">
            <Frame size="large" src={mintable ? services.studio.contentUrl(artwork.id) : null} alt={`${artwork.title}, by ${artist?.displayName ?? shortHash(artwork.artist, 6)}`} />
            <div className="artwork__side">
              <Panel title="Provenance">
                <dl className="facts">
                  <Fact label="Artist">
                    <Link to={{ name: 'gallery', page: 1, artist: artwork.artist }} className="artist-link" data-testid="artist-link">
                      {artist?.displayName ? <>{artist.displayName} · </> : null}
                      <span className="mono">{shortHash(artwork.artist, 6)}</span>
                    </Link>
                    {artist ? <span className="small muted"> · {artist.artworks} in the gallery</span> : null}
                  </Fact>
                  <Fact label="Edition">
                    {editions !== null ? (
                      <span data-testid="editions">
                        {editions === 0 ? 'Not minted yet' : `${editions} minted`}
                        {typeof artwork.maxEditions === 'number' ? ` of ${artwork.maxEditions}` : ' · open edition'}
                      </span>
                    ) : (
                      <span className="muted">Open edition</span>
                    )}
                  </Fact>
                  <Fact label="Bytes">
                    <Mono>{formatBytesExact(artwork.contentLength)}</Mono>{' '}
                    <span className="muted">({formatSize(artwork.contentLength)} · {artwork.contentType})</span>
                    {tier ? <> <Badge tone="brass">{TIER_LABELS[tier.tier]}</Badge></> : null}
                  </Fact>
                  <Fact label="SHA-256">
                    <Mono wrap>{artwork.contentSha256 ?? '—'}</Mono>
                  </Fact>
                  <Fact label="Hung">
                    <span className="mono">{formatTimestamp(artwork.createdAt)}</span>
                  </Fact>
                </dl>
                <div className="actions">
                  <Button disabled={!mintable} onClick={mint}>
                    Mint this Degent
                  </Button>
                </div>
                {!mintable ? (
                  <p className="small muted">This piece is {artwork.status}; only approved Degents can be minted.</p>
                ) : (
                  <p className="small muted">
                    The mint inscribes exactly these bytes under the club’s parent, pays the artist a royalty in your funding
                    transaction, and delivers the Degent to your ordinals address.
                  </p>
                )}
              </Panel>
            </div>
          </div>
          <Panel kicker="House rules" title="Every Degent here passed these">
            <RulesPills />
          </Panel>
        </>
      ) : null}
    </div>
  );
}
