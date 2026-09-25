import { useAsync, useSite, type Async } from '../context';
import type { CollectionStats } from '../services/types';
import { useDocumentMeta } from '../lib/meta';
import { formatCount, formatGB, formatMB, projectedBytes } from '../lib/stats';
import { provenance } from '../chrome/Meters';
import { Link } from '../router';
import { Icon } from '../components/Icons';
import { Cta, DegentImage, Frame, Hero, SectionTitle } from '../components/ui';
import { ComicTeaser, ExhibitTeaser, MinterBanner } from '../components/Sections';

function StatTiles({ stats }: { stats: Async<CollectionStats> }) {
  const s = stats.status === 'ok' ? stats.value : null;
  const proj = s ? projectedBytes(s) : null;
  const na = stats.status === 'loading' ? '…' : '—';
  const tiles = [
    { label: 'Supply', value: s ? formatCount(s.supply) : '10,000', note: 'the collection target' },
    { label: 'Minted', value: s ? formatCount(s.minted) : na, note: s?.source === 'certified' ? 'certified' : 'bundled snapshot' },
    { label: 'Blockspace', value: s ? formatMB(s.bytes) : na, note: 'content bytes on chain' },
    { label: 'Projected at 10K', value: proj !== null ? `~${formatGB(proj)}` : na, note: 'projection, not a fact' },
  ];
  return (
    <section className="stats-band" aria-labelledby="stats-h">
      <h2 id="stats-h" className="sr-only">
        Collection stats
      </h2>
      <ul className="tiles" data-testid="home-stats">
        {tiles.map((t) => (
          <li key={t.label} className="tile">
            <span className="tile__label">{t.label}</span>
            <span className="tile__value">{t.value}</span>
            <span className="tile__note">{t.note}</span>
          </li>
        ))}
      </ul>
      <p className="small muted center">{s ? provenance(s) : stats.status === 'error' ? 'Certification unavailable: numbers are hidden rather than guessed.' : 'Loading…'}</p>
    </section>
  );
}

export function Home({ stats }: { stats: Async<CollectionStats> }) {
  const { site, mint } = useSite();
  useDocumentMeta({ title: 'The Decentralized Gentlemen Club', description: 'A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.' });
  const list = useAsync(() => site.collection.list(), [site]);
  const queue = useAsync(() => mint.mintApi.getQueue(), [mint]);
  const items = list.status === 'ok' ? list.value.items : [];
  const latest = items.slice(-8).reverse();

  return (
    <>
      <Hero
        kicker="Degents on Bitcoin"
        title={
          <>
            The Decentralized <span className="accent">Gentlemen</span> Club
          </>
        }
        sub="Rare Pepes in tuxedos, inscribed on Bitcoin. Make yours in the Atelier or bring your own art, then mint it: non-custodial, what you preview is what lands on chain."
        wall={items.slice(0, 18)}
      >
        <Cta to="/mint" icon={<Icon.rocket />}>
          Mint Now
        </Cta>
        <Cta to="/atelier" variant="dark" icon={<Icon.brush />}>
          Enter the Atelier
        </Cta>
      </Hero>

      <div className="container stack">
        <StatTiles stats={stats} />

        <section aria-labelledby="latest-h">
          <SectionTitle kicker="Fresh on chain" title="Latest mints" id="latest-h" />
          <p className="small muted" data-testid="queue-line">
            {queue.status === 'ok'
              ? `Mint queue now: ${queue.value.standardLaneLength} in the standard lane · ${queue.value.blockLaneLength} in the block lane${site.mode === 'demo' ? ' (demo)' : ''}.`
              : queue.status === 'error'
                ? 'Mint queue unavailable.'
                : 'Checking the mint queue…'}
          </p>
          {latest.length ? (
            <ul className="strip" data-testid="latest">
              {latest.map((it) => (
                <li key={it.id}>
                  <Link to={`/collection/${it.number}`} className="gallery__item" aria-label={`Degent #${it.number}`}>
                    <Frame caption={`DEGENT #${it.number}`}>
                      <DegentImage item={it} />
                    </Frame>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{list.status === 'loading' ? 'Loading…' : 'No mints to show yet.'}</p>
          )}
          <div className="cta-row">
            <Cta to="/collection" variant="dark" icon={<Icon.grid />}>
              See the whole collection
            </Cta>
          </div>
        </section>

        <ExhibitTeaser />
        <ComicTeaser />
      </div>
      <MinterBanner wall={items.slice(18, 30)} />
    </>
  );
}
