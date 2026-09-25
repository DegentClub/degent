/**
 * Global chrome (site spec "Global chrome"): a sticky black header with the wordmark, the two live
 * meters once the page is scrolled, Mint (gradient) and Buy (Magic Eden) buttons and a hamburger that
 * opens the slide-out navigation; a thin green scroll-progress bar under it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMint } from '../flow/context';
import { useSite } from '../flow/site';
import { shortHash } from '../lib/format';
import { useRoute, type Route } from '../lib/router';
import { useScroll } from '../lib/scroll';
import { MAGIC_EDEN_COLLECTION } from '../lib/site';
import { Button } from './ui';
import { GemMark, Icon } from './Icons';
import { Link } from './Link';
import { LiveMeters } from './Meters';

/** Scroll distance after which the header shows the meters. */
export const METERS_AFTER_PX = 120;

export function Wordmark() {
  return (
    <span className="wordmark">
      degent<span className="wordmark__tld">.club</span>
    </span>
  );
}

type Section = 'home' | 'about' | 'collection' | 'gallery' | 'mint-process' | 'manifesto' | 'blog' | 'studio' | 'mint' | null;

export function sectionOf(r: Route): Section {
  switch (r.name) {
    case 'home':
    case 'about':
    case 'collection':
    case 'gallery':
    case 'mint-process':
    case 'manifesto':
    case 'blog':
    case 'mint':
      return r.name;
    case 'blog-post':
      return 'blog';
    case 'artwork':
    case 'artist':
      return 'gallery';
    case 'studio':
    case 'studio-upload':
    case 'studio-royalties':
      return 'studio';
    default:
      return null;
  }
}

const NAV: ReadonlyArray<{ section: Exclude<Section, null | 'mint'>; label: string; to: Route; icon: () => ReactNode }> = [
  { section: 'home', label: 'Home', to: { name: 'home' }, icon: Icon.Home },
  { section: 'about', label: 'About', to: { name: 'about' }, icon: Icon.Info },
  { section: 'collection', label: 'The Collection', to: { name: 'collection', page: 1, perPage: null, item: null }, icon: Icon.Grid },
  { section: 'gallery', label: 'Gallery', to: { name: 'gallery', page: 1, artist: null }, icon: Icon.Frame },
  { section: 'mint-process', label: 'Mint Process', to: { name: 'mint-process' }, icon: Icon.List },
  { section: 'manifesto', label: 'Manifesto', to: { name: 'manifesto' }, icon: Icon.Scroll },
  { section: 'blog', label: 'Blog', to: { name: 'blog' }, icon: Icon.Pen },
  { section: 'studio', label: 'Studio', to: { name: 'studio' }, icon: Icon.Palette },
];

export function NavPanel({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus: () => void }) {
  const route = useRoute();
  const current = sectionOf(route);
  const { theme, setTheme } = useSite();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const wasOpen = useRef(false);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  // Focus the close button on open; give focus back to the hamburger on close.
  useEffect(() => {
    document.documentElement.classList.toggle('has-modal', open);
    if (open) {
      closeRef.current?.focus();
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      returnFocusRef.current();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      // Keep focus inside the open panel.
      const f = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
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
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={['navpanel', open ? 'is-open' : ''].filter(Boolean).join(' ')} aria-hidden={!open} inert={!open}>
      <button type="button" className="navpanel__backdrop" tabIndex={-1} aria-label="Close menu" onClick={onClose} />
      <div ref={panelRef} className="navpanel__sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} id="site-menu">
        <div className="navpanel__top">
          <p id={titleId} className="navpanel__title">
            <Wordmark />
          </p>
          <button ref={closeRef} type="button" className="iconbtn" aria-label="Close menu" onClick={onClose}>
            <Icon.Close />
          </button>
        </div>
        <nav aria-label="Site">
          <ul className="navpanel__list">
            {NAV.map((n) => (
              <li key={n.section}>
                <Link to={n.to} onClick={onClose} aria-current={current === n.section ? 'page' : undefined}>
                  <span className="navpanel__icon">{n.icon()}</span>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary btn--block" onClick={onClose}>
          <Icon.Rocket /> Mint Now!
        </Link>
        <a className="btn btn--dark btn--block" href={MAGIC_EDEN_COLLECTION} target="_blank" rel="noopener noreferrer">
          <Icon.Cart /> Buy on Magic Eden<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button type="button" className="themeswitch" aria-pressed={theme === 'light'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
          {theme === 'light' ? <Icon.Moon /> : <Icon.Sun />}
          Light theme
        </button>
      </div>
    </div>
  );
}

export function SiteHeader() {
  const { state, dispatch } = useMint();
  const { y, progress } = useScroll();
  const [open, setOpen] = useState(false);
  const burger = useRef<HTMLButtonElement>(null);
  const w = state.wallet;
  const locked = state.step === 'pay' && state.pay.phase !== 'idle' && state.pay.phase !== 'error';
  const scrolled = y > METERS_AFTER_PX;
  const route = useRoute();
  const current = sectionOf(route);

  return (
    <>
      <header className={['site-header', scrolled ? 'is-scrolled' : ''].filter(Boolean).join(' ')} data-testid="site-header">
        <div className="site-header__row">
          <Link to={{ name: 'home' }} className="brand" aria-label="degent.club home">
            <GemMark />
            <Wordmark />
          </Link>
          <div className="site-header__meters" data-shown={scrolled ? 'true' : 'false'}>
            <LiveMeters compact />
          </div>
          <div className="site-header__actions">
            {w ? (
              <span className="chip site-header__wallet" title={w.ordinals.address}>
                <span className="chip__dot" aria-hidden="true" />
                {w.name} · <span className="mono">{shortHash(w.ordinals.address, 4)}</span>
                <Button
                  variant="ghost"
                  className="chip__btn"
                  disabled={locked}
                  onClick={() => {
                    void w.disconnect().catch(() => undefined);
                    dispatch({ type: 'WALLET_DISCONNECTED' });
                  }}
                >
                  Disconnect
                </Button>
              </span>
            ) : null}
            <Link to={{ name: 'mint', artworkId: null }} className="btn btn--primary btn--sm" aria-current={current === 'mint' ? 'page' : undefined}>
              <Icon.Rocket /> Mint
            </Link>
            <a className="btn btn--dark btn--sm site-header__buy" href={MAGIC_EDEN_COLLECTION} target="_blank" rel="noopener noreferrer">
              <Icon.Cart /> Buy<span className="sr-only"> on Magic Eden (opens in a new tab)</span>
            </a>
            <button
              ref={burger}
              type="button"
              className="iconbtn iconbtn--menu"
              aria-label="Menu"
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => setOpen(true)}
            >
              <Icon.Menu />
            </button>
          </div>
        </div>
        <div className="scroll-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>
      <NavPanel open={open} onClose={() => setOpen(false)} returnFocus={() => burger.current?.focus()} />
    </>
  );
}
