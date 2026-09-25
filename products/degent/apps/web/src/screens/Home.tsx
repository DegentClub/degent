/**
 * `#/`: Home (site spec IA): hero over the wall of certified Degents, the live meters, the collection
 * card with certified vs projected stats, CTAs to Mint and the Gallery, the comic and the Minter banner.
 * The hero copy reuses captured copy only (collection name and footer tagline); nothing is invented.
 */
import { useMint } from '../flow/context';
import { Link } from '../components/Link';
import { LiveMeters } from '../components/Meters';
import { CollectionCard, ComicSection, MinterBanner, PageHero } from '../components/Sections';
import { Alert } from '../components/ui';
import { COPY, TAGLINE } from '../lib/site';

export function Home() {
  const { state } = useMint();
  return (
    <div className="screen screen--site screen--home">
      {state.resumeOffer ? (
        <Alert tone="warn" title="You have a mint in progress">
          Order <span className="mono">{state.resumeOffer.orderId}</span> is saved on this device.{' '}
          <Link to={{ name: 'mint', artworkId: null }}>Resume it at the mint</Link>.
        </Alert>
      ) : null}
      <PageHero pill="degent.club" title={COPY.cardTitle} sub={TAGLINE}>
        <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary">
          Mint Now <span aria-hidden="true">🚀</span>
        </Link>
        <Link to={{ name: 'gallery', page: 1, artist: null }} className="btn btn--dark">
          Gallery
        </Link>
        <Link to={{ name: 'collection', page: 1, perPage: null, item: null }} className="btn btn--dark">
          The Collection
        </Link>
      </PageHero>
      <section className="home-meters" aria-label="Live meters">
        <LiveMeters />
      </section>
      <CollectionCard />
      <ComicSection />
      <MinterBanner />
    </div>
  );
}
