/**
 * Collection lightbox: a modal dialog with the Degent, its on-chain details, prev/next and a filmstrip of the
 * page. Keyboard: Escape closes, ←/→ step through the page, Tab stays inside; focus returns to the opener.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { RegisterMember } from '@bsh/degent-mint-sdk';
import { DegentDetails } from './DegentDetails';
import { GoldFrame, SiteLink } from './components';
import { Icon } from './chrome';

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: RegisterMember[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
  const m = items[index]!;

  useEffect(() => {
    closeBtn.current?.focus();
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const prev = () => onIndex((index - 1 + items.length) % items.length);
  const next = () => onIndex((index + 1) % items.length);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'Tab' && box.current) {
      const f = [...box.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className="lightbox" onKeyDown={onKey}>
      <button type="button" className="lightbox__backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div className="lightbox__panel" role="dialog" aria-modal="true" aria-labelledby="lightbox-title" ref={box}>
        <button ref={closeBtn} type="button" className="icon-btn lightbox__close" aria-label="Close" onClick={onClose}>
          <Icon.close />
        </button>
        <div className="lightbox__body">
          <div className="lightbox__art">
            <GoldFrame src={m.contentUrl} alt={`Degent #${m.n}`} size="lg" />
            <div className="row lightbox__nav">
              <button type="button" className="btn btn--dark btn--sm" onClick={prev} aria-label="Previous Degent">
                ‹ Prev
              </button>
              <button type="button" className="btn btn--dark btn--sm" onClick={next} aria-label="Next Degent">
                Next ›
              </button>
            </div>
          </div>
          <div className="lightbox__info">
            <h2 id="lightbox-title" className="mono">
              DEGENT #{m.n}
            </h2>
            <DegentDetails member={m} />
            <p className="small">
              <SiteLink to={`/collection/${m.n}`}>Open the page for Degent #{m.n}</SiteLink> (shareable link)
            </p>
          </div>
        </div>
        <ul className="filmstrip" aria-label="This page">
          {items.map((it, i) => (
            <li key={it.n}>
              <button type="button" className={`filmstrip__btn ${i === index ? 'is-on' : ''}`} aria-label={`Show Degent #${it.n}`} aria-current={i === index ? 'true' : undefined} onClick={() => onIndex(i)}>
                <img src={it.contentUrl} alt="" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
