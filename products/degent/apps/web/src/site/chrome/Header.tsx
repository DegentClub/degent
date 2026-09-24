import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '../router';
import { useSite, type Async } from '../context';
import { Icon, LogoMark } from '../components/Icons';
import type { CollectionStats } from '../services/types';
import { Meters } from './Meters';
import { NavPanel } from './NavPanel';

export function Wordmark() {
  return (
    <span className="brand__word">
      degent<span className="brand__dot">.club</span>
    </span>
  );
}

/** Thin scroll-progress bar under the header (static when reduced motion is requested). */
export function ScrollProgress() {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = document.documentElement;
        const max = el.scrollHeight - el.clientHeight;
        setP(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);
  return (
    <div className="scrollbar" aria-hidden="true">
      <span className="scrollbar__fill" style={{ transform: `scaleX(${p})` }} />
    </div>
  );
}

export function Header({ stats }: { stats: Async<CollectionStats> }) {
  const { app } = useSite();
  const [open, setOpen] = useState(false);
  const burger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const returnFocus = useCallback(() => burger.current, []);
  return (
    <>
      <header className="site-header">
        <div className="site-header__row container--wide">
          <Link to="/" className="brand" aria-label="degent.club home">
            <LogoMark />
            <Wordmark />
          </Link>
          <div className="site-header__meters">
            <Meters stats={stats} />
          </div>
          <div className="site-header__actions">
            <Link to="/mint" className="cta cta--gradient cta--sm">
              <span>Mint</span>
              <span className="cta__icon">
                <Icon.rocket />
              </span>
            </Link>
            <a href={app.marketplaceUrl} className="cta cta--dark cta--sm" target="_blank" rel="noopener noreferrer">
              <span>Buy</span>
              <span className="cta__icon">
                <Icon.cart />
              </span>
              <span className="sr-only"> on Magic Eden (opens in a new tab)</span>
            </a>
            <button
              ref={burger}
              type="button"
              className="iconbtn iconbtn--menu"
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => setOpen(true)}
            >
              <Icon.menu />
            </button>
          </div>
        </div>
        <div className="site-header__strip">
          <Meters stats={stats} compact />
        </div>
        <ScrollProgress />
      </header>
      <NavPanel open={open} onClose={close} returnFocus={returnFocus} />
    </>
  );
}
