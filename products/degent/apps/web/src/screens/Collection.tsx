/**
 * `#/collection`: the certified membership (site spec "Collection page"): hero, collection card, the
 * paged grid of gold-framed `DEGENT #N` tiles, the lightbox (`#/collection/:n`), the comic and the
 * Degen Minter banner. Every number comes from the block.space attestation.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMint } from '../flow/context';
import { useSite } from '../flow/site';
import { Frame } from '../components/Frame';
import { Lightbox } from '../components/Lightbox';
import { Link } from '../components/Link';
import { Pagination } from '../components/Pagination';
import { CollectionCard, ComicSection, MinterBanner, PageHero } from '../components/Sections';
import { Alert } from '../components/ui';
import { groupDigits } from '../lib/format';
import { clampPage, pageCount } from '../lib/pagination';
import { navigate, PER_PAGE_OPTIONS, type Route } from '../lib/router';
import { COPY } from '../lib/site';
import type { CertifiedItem } from '../services/certifyApi';

export const DEFAULT_PER_PAGE = PER_PAGE_OPTIONS[0];

export function Collection({ page: askedPage, perPage: askedPer, item }: { page: number; perPage: number | null; item: number | null }) {
  const { services } = useMint();
  const { certificate, members } = useSite();
  const perPage = askedPer ?? DEFAULT_PER_PAGE;
  const total = certificate.status === 'ready' ? certificate.counts.minted : 0;
  const pages = pageCount(total, perPage);
  // With a Degent open, the grid behind it shows that Degent's page.
  const page = clampPage(item !== null ? Math.ceil(item / perPage) : askedPage, pages);
  const start = (page - 1) * perPage;
  const end = Math.min(total, start + perPage);
  const [, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const tiles: CertifiedItem[] | null = total > 0 ? members.peek(start, end) : null;

  useEffect(() => {
    if (total === 0) return;
    let alive = true;
    setError(null);
    members
      .load(start, end)
      .then(() => alive && setLoaded((v) => v + 1))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [members, start, end, total]);

  const routeFor = useCallback((p: number): Route => ({ name: 'collection', page: p, perPage: askedPer, item: null }), [askedPer]);
  const onNavigate = useCallback((n: number) => navigate({ name: 'collection', page: 1, perPage: askedPer, item: n }, { replace: true }), [askedPer]);
  const onClose = useCallback(() => navigate({ name: 'collection', page: item !== null ? Math.ceil(item / perPage) : page, perPage: askedPer, item: null }, { replace: true }), [item, perPage, page, askedPer]);
  const openItem = item !== null && total > 0 && item >= 1 && item <= total ? item : null;

  return (
    <div className="screen screen--site screen--collection">
      <PageHero pill="Degens" title={COPY.collectionHeroTitle} sub={COPY.collectionHeroSub}>
        <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary">
          Mint Now <span aria-hidden="true">🚀</span>
        </Link>
        <Link to={{ name: 'mint-process' }} className="btn btn--dark">
          Learn How
        </Link>
      </PageHero>

      <CollectionCard />

      <section className="members" aria-labelledby="members-title">
        <h2 id="members-title" className="section-title">
          Certified members
        </h2>
        {certificate.status === 'error' ? (
          <Alert tone="warn" title="The members cannot be listed">
            The block.space certificate is unavailable, so the grid is empty rather than guessed.
          </Alert>
        ) : null}
        {error ? <Alert tone="bad" title="block.space did not return this page">{error}</Alert> : null}
        {total > 0 ? (
          <>
            <Pagination
              total={total}
              page={page}
              perPage={perPage}
              routeFor={routeFor}
              onPage={(p) => navigate(routeFor(p))}
              onPerPage={(pp) => navigate({ name: 'collection', page: Math.floor(start / pp) + 1, perPage: pp === DEFAULT_PER_PAGE ? null : pp, item: null })}
            />
            <ul className="degent-grid" aria-label="Certified Degents" aria-busy={tiles === null || undefined}>
              {Array.from({ length: end - start }, (_, i) => {
                const n = start + i + 1;
                const t = tiles?.[i];
                return (
                  <li key={n}>
                    <Link
                      to={{ name: 'collection', page: 1, perPage: askedPer, item: n }}
                      className="degent-tile"
                      aria-label={t ? `DEGENT #${n}, inscription ${groupDigits(t.number)}` : `DEGENT #${n}`}
                    >
                      <Frame src={t ? services.ord.contentUrl(t.inscriptionId) : null} alt={`DEGENT #${n}`} plaque={`DEGENT #${n}`} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </section>

      <ComicSection />
      <MinterBanner />

      {openItem !== null ? <Lightbox n={openItem} total={total} onNavigate={onNavigate} onClose={onClose} /> : null}
      {item !== null && total > 0 && openItem === null ? (
        <Alert tone="warn" title={`There is no DEGENT #${groupDigits(item)}`}>
          The certificate lists {groupDigits(total)} members. <Link to={routeFor(1)}>Back to the first page</Link>.
        </Alert>
      ) : null}
    </div>
  );
}
