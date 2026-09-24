/**
 * `/comic`: the comic, embedded straight from the chain (ord `/content/<id>`). Reader controls: zoom, full
 * screen, open on ordinals.com; with VITE_COMIC_PAGES also page by page (buttons and ←/→). A placeholder until
 * the inscription id is configured.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useMint } from '../flow/context';
import { ExternalLink } from '../components/ui';
import { CtaLink, useDocumentMeta } from '../site/components';
import { ordinalsUrl } from '../site/DegentDetails';

const ZOOMS = [0.75, 1, 1.25, 1.5, 2] as const;

export function Comic() {
  const { app } = useMint();
  const pages = app.comicPages;
  const id = app.comicInscriptionId;
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const reader = useRef<HTMLDivElement>(null);
  useDocumentMeta({
    title: 'The Comic · degent.club',
    description: 'Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History.',
  });

  const zoomIn = () => setZoom((z) => ZOOMS.find((x) => x > z) ?? z);
  const zoomOut = () => setZoom((z) => [...ZOOMS].reverse().find((x) => x < z) ?? z);
  const fullscreen = () => {
    const el = reader.current as (HTMLDivElement & { requestFullscreen?: () => Promise<void> }) | null;
    void el?.requestFullscreen?.().catch(() => undefined);
  };
  const paged = pages.length > 0;
  const current = paged ? pages[page]! : id;
  const onKey = (e: KeyboardEvent) => {
    if (!paged) return;
    if (e.key === 'ArrowRight') setPage((p) => Math.min(pages.length - 1, p + 1));
    if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1));
  };

  return (
    <div className="page">
      <div className="page-head">
        <p className="badge-pill">The lore</p>
        <h1 tabIndex={-1}>This is Gentlemen- The Comic</h1>
        <p className="lede">Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History.</p>
      </div>

      {!current ? (
        <section className="card comic-placeholder" aria-labelledby="comic-soon">
          <div className="comic-teaser__cover" aria-hidden="true">
            <span>THE DECENTRALIZED GENTLEMEN CLUB</span>
          </div>
          <div>
            <h2 id="comic-soon">The comic is on chain; the reader is waiting for its id</h2>
            <p>
              This page embeds the comic straight from its inscription. Its inscription id is not configured on this deployment yet
              (<span className="mono">VITE_COMIC_INSCRIPTION_ID</span>).
            </p>
            <CtaLink to="/collection">Browse the collection meanwhile</CtaLink>
          </div>
        </section>
      ) : (
        <section aria-label="Comic reader" className="comic-reader">
          <div className="toolbar" role="toolbar" aria-label="Reader controls">
            {paged ? (
              <>
                <button type="button" className="btn btn--dark btn--sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ‹ Previous page
                </button>
                <span role="status" className="mono">
                  Page {page + 1} of {pages.length}
                </span>
                <button type="button" className="btn btn--dark btn--sm" disabled={page >= pages.length - 1} onClick={() => setPage(page + 1)}>
                  Next page ›
                </button>
              </>
            ) : null}
            <button type="button" className="btn btn--dark btn--sm" onClick={zoomOut} disabled={zoom === ZOOMS[0]} aria-label="Zoom out">
              −
            </button>
            <span className="mono" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <button type="button" className="btn btn--dark btn--sm" onClick={zoomIn} disabled={zoom === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="btn btn--dark btn--sm" onClick={fullscreen}>
              Full screen
            </button>
            <ExternalLink href={ordinalsUrl(app.ordContentUrl, current)}>View on ordinals.com</ExternalLink>
          </div>
          <div className="comic-reader__stage" ref={reader} tabIndex={0} onKeyDown={onKey} aria-label={paged ? 'Comic page; use the arrow keys to turn pages' : 'Comic'}>
            <div className="comic-reader__zoom" style={{ transform: `scale(${zoom})` }}>
              {paged ? (
                <img src={`${app.ordContentUrl}/content/${encodeURIComponent(current)}`} alt={`Comic page ${page + 1} of ${pages.length}`} />
              ) : (
                <iframe
                  title="The Decentralized Gentlemen Club comic, from its inscription"
                  src={`${app.ordContentUrl}/content/${encodeURIComponent(current)}`}
                  sandbox="allow-scripts"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
