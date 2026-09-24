import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '../router';
import { useAsync, useSite, type Async } from '../context';
import type { CollectionStats } from '../services/types';
import { paginate, pageOfIndex } from '../lib/pagination';
import { useDocumentMeta } from '../lib/meta';
import { Icon } from '../components/Icons';
import { Cta, DegentImage, Frame, Hero, Notice } from '../components/ui';
import { CollectionCard, ComicTeaser, MinterBanner } from '../components/Sections';
import { PageSelects, Pagination, ShowingLine } from '../components/Pagination';
import { Lightbox } from '../components/Lightbox';

export function Collection({ n, stats }: { n: number | null; stats: Async<CollectionStats> }) {
  const { site } = useSite();
  const { navigate } = useRouter();
  const list = useAsync(() => site.collection.list(), [site]);
  const items = list.status === 'ok' ? list.value.items : [];
  const [perPage, setPerPage] = useState(20);
  const [page, setPage] = useState(1);
  const galleryRef = useRef<HTMLElement>(null);
  const lastOpener = useRef<number | null>(null);

  const index = useMemo(() => (n === null ? -1 : items.findIndex((it) => it.number === n)), [items, n]);

  // A deep link (or stepping in the lightbox) keeps the grid on the page that holds the item.
  useEffect(() => {
    if (index >= 0) setPage(pageOfIndex(index, perPage));
  }, [index, perPage]);

  const info = paginate(items.length, perPage, page);
  const pageItems = items.slice(info.start, info.end);

  const item = index >= 0 ? items[index]! : null;
  useDocumentMeta(
    n === null
      ? { title: 'The Collection', description: "Together we're minting bitcoin's biggest collection: 10,000 Rare Pepes ordinals in tuxedos." }
      : {
          title: `Degent #${n}`,
          description: item ? `Degent #${n} of the Decentralized Gentlemen Club. Inscription ${item.id}.` : `Degent #${n}`,
          ...(item && site.mode === 'live' ? { image: site.ord.contentUrl(item.id) } : {}),
        },
  );

  const goPage = (p: number) => {
    setPage(p);
    galleryRef.current?.scrollIntoView?.({ block: 'start' });
  };

  const close = useCallback(() => {
    navigate('/collection', { keepScroll: true });
    const opener = lastOpener.current;
    if (opener !== null) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-degent="${opener}"]`)?.focus());
  }, [navigate]);
  const go = useCallback((num: number) => navigate(`/collection/${num}`, { keepScroll: true, replace: true }), [navigate]);

  return (
    <>
      <Hero
        kicker="Degens"
        title="The Collection"
        sub="Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard on-chain."
        wall={items.slice(0, 18)}
      >
        <Cta to="/mint" icon={<Icon.rocket />}>
          Mint Now
        </Cta>
        <Cta to="/how-it-works" variant="dark">
          Learn How
        </Cta>
      </Hero>

      <div className="container stack">
        <CollectionCard stats={stats} first={items[0] ?? null} />

        <section ref={galleryRef} className="gallery" aria-labelledby="gallery-h">
          <h2 id="gallery-h" className="sr-only">
            Gallery
          </h2>
          {list.status === 'loading' ? <p className="muted">Loading the collection…</p> : null}
          {list.status === 'error' ? <Notice tone="bad" title="Could not load the collection">{list.error}</Notice> : null}
          {list.status === 'ok' ? (
            <>
              {list.value.source === 'bundled' ? (
                <p className="small muted" data-testid="membership-source">
                  Membership: bundled snapshot of {items.length.toLocaleString('en-US')} Degents (not certified{site.mode === 'demo' ? ', demo' : ''}).
                </p>
              ) : (
                <p className="small muted" data-testid="membership-source">
                  Membership: block.space certified list.
                </p>
              )}
              <div className="gallery__toolbar">
                <ShowingLine info={info} />
                <PageSelects info={info} onPage={goPage} onPerPage={(pp) => { setPerPage(pp); setPage(1); }} />
              </div>
              <ul className="gallery__grid" data-testid="gallery">
                {pageItems.map((it) => (
                  <li key={it.id}>
                    <Link
                      to={`/collection/${it.number}`}
                      keepScroll
                      className="gallery__item"
                      data-degent={it.number}
                      onClick={() => (lastOpener.current = it.number)}
                      aria-label={`Degent #${it.number}, open details`}
                    >
                      <Frame caption={`DEGENT #${it.number}`}>
                        <DegentImage item={it} />
                      </Frame>
                    </Link>
                  </li>
                ))}
              </ul>
              <Pagination info={info} onPage={goPage} />
            </>
          ) : null}
        </section>

        <ComicTeaser />
      </div>
      <MinterBanner wall={items.slice(18, 30)} />

      {n !== null && list.status === 'ok' ? <Lightbox items={items} index={index} missingNumber={n} onClose={close} onGo={go} /> : null}
    </>
  );
}
