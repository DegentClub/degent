import { useEffect, useRef } from 'react';
import { useAsync, useSite } from '../context';
import type { CollectionItem, InscriptionDetails } from '../services/types';
import { Icon } from './Icons';
import { DegentImage, Frame } from './ui';

export function magicEdenItemUrl(id: string): string {
  return `https://magiceden.io/ordinals/item-details/${id}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

const ROWS: Array<{ key: keyof InscriptionDetails; label: string; fmt(d: InscriptionDetails): string }> = [
  { key: 'address', label: 'Address', fmt: (d) => d.address ?? '—' },
  { key: 'contentType', label: 'Content type', fmt: (d) => d.contentType ?? '—' },
  { key: 'contentLength', label: 'Content length', fmt: (d) => (d.contentLength !== null ? `${d.contentLength.toLocaleString('en-US')} bytes` : '—') },
  { key: 'timestamp', label: 'Timestamp', fmt: (d) => fmtTime(d.timestamp) },
  { key: 'height', label: 'Block height', fmt: (d) => (d.height !== null ? d.height.toLocaleString('en-US') : '—') },
  { key: 'fee', label: 'Fee', fmt: (d) => (d.fee !== null ? `${d.fee.toLocaleString('en-US')} sats` : '—') },
];

/**
 * One Degent with its on-chain facts from ord. Neighbours are prefetched (cached in OrdService),
 * so stepping through the collection shows data immediately. Keyboard: ←/→ step, Esc closes.
 */
export function Lightbox({ items, index, missingNumber, onClose, onGo }: { items: CollectionItem[]; index: number; missingNumber: number | null; onClose(): void; onGo(n: number): void }) {
  const { site } = useSite();
  const item = index >= 0 ? items[index]! : null;
  const closeRef = useRef<HTMLButtonElement>(null);
  const details = useAsync(() => (item ? site.ord.getInscription(item.id) : Promise.resolve(null)), [item?.id, site]);
  const prev = index > 0 ? items[index - 1]! : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1]! : null;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    for (const d of [1, -1, 2, -2]) {
      const n = items[index + d];
      if (n) site.ord.prefetch(n.id);
    }
  }, [index, items, site]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev && !(e.target instanceof HTMLInputElement)) onGo(prev.number);
      else if (e.key === 'ArrowRight' && next && !(e.target instanceof HTMLInputElement)) onGo(next.number);
    };
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('is-locked');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('is-locked');
    };
  }, [onClose, onGo, prev, next]);

  const strip = index >= 0 ? items.slice(Math.max(0, index - 4), Math.min(items.length, index + 5)) : [];
  const title = item ? `DEGENT #${item.number}` : `DEGENT #${missingNumber ?? '?'}`;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-labelledby="lb-title" data-testid="lightbox">
      <div className="lightbox__scrim" onClick={onClose} aria-hidden="true" />
      <div className="lightbox__panel">
        <button ref={closeRef} type="button" className="iconbtn lightbox__close" onClick={onClose} aria-label="Close">
          <Icon.close />
        </button>
        {item ? (
          <div className="lightbox__body">
            <div className="lightbox__media">
              <Frame plaque="DEGEN">
                <DegentImage item={item} eager />
              </Frame>
              <button type="button" className="lightbox__nav lightbox__nav--prev" disabled={!prev} onClick={() => prev && onGo(prev.number)} aria-label="Previous Degent">
                <Icon.chevronLeft />
              </button>
              <button type="button" className="lightbox__nav lightbox__nav--next" disabled={!next} onClick={() => next && onGo(next.number)} aria-label="Next Degent">
                <Icon.chevronRight />
              </button>
            </div>
            <div className="lightbox__info">
              <h2 id="lb-title">{title}</h2>
              <dl className="lb-facts" aria-busy={details.status === 'loading'} data-testid="lb-facts" data-status={details.status}>
                <div className="lb-facts__row lb-facts__row--wide">
                  <dt>Inscription ID</dt>
                  <dd className="mono mono--wrap">{item.id}</dd>
                </div>
                {ROWS.map((r) => (
                  <div className="lb-facts__row" key={r.key}>
                    <dt>{r.label}</dt>
                    <dd className={r.key === 'address' ? 'mono mono--wrap' : 'mono'} data-testid={`lb-${r.key}`}>
                      {details.status === 'loading' ? <span className="loading-dots">Loading…</span> : details.status === 'error' ? '—' : details.value ? r.fmt(details.value) : '—'}
                    </dd>
                  </div>
                ))}
              </dl>
              {details.status === 'error' ? (
                <p className="lb-error" role="alert">
                  Could not load the on-chain details from ord.{' '}
                  <button type="button" className="linkbtn" onClick={details.reload}>
                    Retry
                  </button>
                </p>
              ) : null}
              <div className="cta-row">
                <a className="cta cta--gradient" href={site.ord.inscriptionUrl(item.id)} target="_blank" rel="noopener noreferrer">
                  <span>View on Ordinals.com</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <a className="cta cta--dark" href={magicEdenItemUrl(item.id)} target="_blank" rel="noopener noreferrer">
                  <span>Buy Item</span>
                  <span className="cta__icon">
                    <Icon.cart />
                  </span>
                  <span className="sr-only"> on Magic Eden (opens in a new tab)</span>
                </a>
              </div>
              <p className="small muted">On-chain facts: ord JSON API{site.mode === 'demo' ? ' (demo fixtures)' : ''}. Membership: block.space certification.</p>
            </div>
          </div>
        ) : (
          <div className="lightbox__body lightbox__body--empty">
            <h2 id="lb-title">{title}</h2>
            <p>This number is not in the collection list yet. It may not be minted, or the list has not been certified since.</p>
          </div>
        )}
        {strip.length ? (
          <ul className="filmstrip" aria-label="Nearby Degents">
            {strip.map((it) => (
              <li key={it.id}>
                <button type="button" className={`filmstrip__btn ${it.number === item?.number ? 'is-current' : ''}`} onClick={() => onGo(it.number)} aria-label={`Degent #${it.number}`} aria-current={it.number === item?.number ? 'true' : undefined}>
                  <DegentImage item={it} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
