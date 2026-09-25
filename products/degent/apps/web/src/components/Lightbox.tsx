/**
 * The collection lightbox (site spec §4): image left; `DEGENT #N` with the inscription id, owner address,
 * content type and length, timestamp, block height and fee; "View on Ordinals.com" and "Buy Item";
 * prev/next and a thumbnail filmstrip.
 *
 * What block.space certifies (id, number, type, length, height, attribution) is shown at once from the
 * member index; what only ord knows (address, timestamp, fee) comes from the shared details cache. The
 * neighbours' details and images are prefetched, so prev/next never flashes "LOADING…" (defect fixed).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMint } from '../flow/context';
import { useOrdDetails, useSite } from '../flow/site';
import { preloadImage } from '../lib/detailsCache';
import { formatBytesExact, formatSats, formatSize, formatTimestamp, groupDigits, shortHash } from '../lib/format';
import { magicEdenItemUrl } from '../lib/site';
import { verifiedRoyaltyOf, type CertifiedItem } from '../services/certifyApi';
import { Frame } from './Frame';
import { Icon } from './Icons';
import { Link } from './Link';
import { Fact, Mono } from './ui';

/** How many neighbours on each side get their details and images prefetched. */
export const PREFETCH_RADIUS = 2;
/** Thumbnails on each side of the current one in the filmstrip. */
export const FILMSTRIP_RADIUS = 4;

const ARTWORK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function Pending() {
  // A quiet shimmer, never a "LOADING…" label; screen readers hear "not yet known".
  return (
    <span className="shimmer">
      <span className="sr-only">not yet known</span>
    </span>
  );
}

export function Lightbox({ n, total, onNavigate, onClose }: { n: number; total: number; onNavigate: (n: number) => void; onClose: () => void }) {
  const { services } = useMint();
  const { members, details } = useSite();
  const lo = Math.max(1, n - FILMSTRIP_RADIUS);
  const hi = Math.min(total, n + FILMSTRIP_RADIUS);
  // Read through the member index on every render (a cheap slice), so a new `n` never shows the old strip.
  const [, setLoaded] = useState(0);
  const strip = members.peek(lo - 1, hi);
  const [failed, setFailed] = useState<string | null>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Items for the filmstrip (and the current one), from the cache when possible.
  useEffect(() => {
    let alive = true;
    const prefetchLo = Math.max(1, n - Math.max(PREFETCH_RADIUS, FILMSTRIP_RADIUS));
    const prefetchHi = Math.min(total, n + Math.max(PREFETCH_RADIUS, FILMSTRIP_RADIUS));
    members
      .load(prefetchLo - 1, prefetchHi)
      .then((around) => {
        if (!alive) return;
        setLoaded((v) => v + 1);
        // Prefetch the neighbours' ord details and images (the current one first).
        const byN = (k: number) => around[k - prefetchLo];
        const order = [n];
        for (let d = 1; d <= PREFETCH_RADIUS; d++) order.push(n + d, n - d);
        const ids = order.map(byN).filter((x): x is CertifiedItem => !!x).map((x) => x.inscriptionId);
        details.prefetch(ids);
        for (const id of ids) preloadImage(services.ord.contentUrl(id));
      })
      .catch((e) => alive && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [n, lo, hi, total, members, details, services.ord]);

  // Focus: into the dialog on open, back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    document.documentElement.classList.add('has-modal');
    return () => {
      document.documentElement.classList.remove('has-modal');
      if (before && document.contains(before)) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' && n > 1) {
        e.preventDefault();
        onNavigate(n - 1);
      } else if (e.key === 'ArrowRight' && n < total) {
        e.preventDefault();
        onNavigate(n + 1);
      } else if (e.key === 'Tab' && dialogRef.current) {
        const f = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [n, total, onClose, onNavigate]);

  const item = strip?.[n - lo] ?? null;
  const ord = useOrdDetails(item?.inscriptionId ?? null);
  const royalty = item ? verifiedRoyaltyOf(item) : null;
  const a = item?.attribution;

  // Portalled to <body>: the screens animate `transform`, which would make them the containing block of a
  // `position: fixed` dialog (it then centred on the page instead of the viewport).
  return createPortal(
    <div className="lightbox" data-testid="lightbox">
      <button type="button" className="lightbox__backdrop" tabIndex={-1} aria-label="Close" onClick={onClose} />
      <div ref={dialogRef} className="lightbox__dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button ref={closeRef} type="button" className="iconbtn lightbox__close" aria-label="Close" onClick={onClose}>
          <Icon.Close />
        </button>
        <div className="lightbox__main">
          <div className="lightbox__art">
            <Frame
              size="large"
              src={item ? services.ord.contentUrl(item.inscriptionId) : null}
              alt={item ? `DEGENT #${n}, inscription ${groupDigits(item.number)}` : `DEGENT #${n}`}
              plaque={`DEGENT #${n}`}
            />
            <div className="lightbox__arrows">
              <button type="button" className="iconbtn" aria-label="Previous Degent" disabled={n <= 1} onClick={() => onNavigate(n - 1)}>
                <Icon.ChevronLeft />
              </button>
              <span className="mono small">
                {groupDigits(n)} / {groupDigits(total)}
              </span>
              <button type="button" className="iconbtn" aria-label="Next Degent" disabled={n >= total} onClick={() => onNavigate(n + 1)}>
                <Icon.ChevronRight />
              </button>
            </div>
          </div>
          <div className="lightbox__side">
            <h2 id={titleId} className="lightbox__title">
              DEGENT #{groupDigits(n)}
            </h2>
            {failed ? <p className="small">This member could not be read from block.space: {failed}</p> : null}
            {item ? (
              <dl className="facts lightbox__facts">
                <Fact label="Inscription ID">
                  <Mono wrap>{item.inscriptionId}</Mono>
                </Fact>
                <Fact label="Inscription number">
                  <Mono>{groupDigits(item.number)}</Mono>
                </Fact>
                {ord === undefined || (ord && ord.address) ? (
                  <Fact label="Address">{ord === undefined ? <Pending /> : <Mono wrap>{ord!.address}</Mono>}</Fact>
                ) : null}
                <Fact label="Content type">
                  <Mono>{item.contentType ?? ord?.contentType ?? 'unknown'}</Mono>
                </Fact>
                <Fact label="Content length">
                  <Mono>{formatBytesExact(item.contentLength)}</Mono> <span className="muted small">({formatSize(item.contentLength)})</span>
                </Fact>
                {ord === undefined || (ord && ord.timestamp !== null) ? (
                  <Fact label="Timestamp">{ord === undefined ? <Pending /> : <Mono>{formatTimestamp(new Date(ord!.timestamp! * 1000).toISOString())}</Mono>}</Fact>
                ) : null}
                <Fact label="Block height">
                  <Mono>{groupDigits(item.height)}</Mono>
                </Fact>
                {ord === undefined || (ord && ord.fee !== null) ? <Fact label="Fee">{ord === undefined ? <Pending /> : <Mono>{formatSats(ord!.fee!)}</Mono>}</Fact> : null}
                {a ? (
                  <Fact label="Artist">
                    <Link to={{ name: 'artist', address: a.artist }} className="artist-link" onClick={onClose}>
                      <span className="mono">{shortHash(a.artist, 6)}</span>
                    </Link>{' '}
                    <span className="small muted">
                      ·{' '}
                      {ARTWORK_ID.test(a.artwork) ? (
                        <Link to={{ name: 'artwork', id: a.artwork }} onClick={onClose}>
                          {a.artwork}
                        </Link>
                      ) : (
                        a.artwork
                      )}
                      {typeof a.edition === 'number' ? ` · edition ${a.edition}` : ''} · asserted by the minter
                    </span>
                  </Fact>
                ) : null}
                {royalty ? (
                  <Fact label="Artist royalty">
                    <Mono>{formatSats(royalty.sats)}</Mono> <span className="small muted">verified on chain · </span>
                    <Mono>
                      {shortHash(royalty.txid, 6)}:{royalty.vout}
                    </Mono>
                  </Fact>
                ) : null}
                <Fact label="Certified from">
                  <span className="small">{item.sources.join(' + ')}</span>
                </Fact>
              </dl>
            ) : null}
            {ord === null && item ? <p className="small muted">ord did not answer; showing what block.space certifies.</p> : null}
            {item ? (
              <div className="row">
                <a className="btn btn--primary" href={services.ord.inscriptionUrl(item.inscriptionId)} target="_blank" rel="noopener noreferrer">
                  View on Ordinals.com<span className="sr-only"> (opens in a new tab)</span> <Icon.External />
                </a>
                <a className="btn btn--dark" href={magicEdenItemUrl(item.inscriptionId)} target="_blank" rel="noopener noreferrer">
                  <Icon.Cart /> Buy Item<span className="sr-only"> on Magic Eden (opens in a new tab)</span>
                </a>
              </div>
            ) : null}
          </div>
        </div>
        <ol className="filmstrip" aria-label="Nearby Degents">
          {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((k) => {
            const it = strip?.[k - lo];
            return (
              <li key={k}>
                <button type="button" className="filmstrip__btn" aria-label={`DEGENT #${k}`} aria-current={k === n ? 'true' : undefined} onClick={() => onNavigate(k)}>
                  {it ? <img src={services.ord.contentUrl(it.inscriptionId)} alt="" loading="lazy" decoding="async" /> : <span className="filmstrip__empty" />}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>,
    document.body,
  );
}
