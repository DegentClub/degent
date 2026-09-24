/**
 * Global chrome from the site spec: sticky header (logo, the two live meters, Mint and Buy, hamburger), a thin
 * scroll-progress bar, the slide-out navigation, the floating social rail with "back to top", and the footer
 * (wordmark, quick links, newsletter).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMint } from '../flow/context';
import { shortHash } from '../lib/format';
import type { Route } from '../router';
import { Button } from '../components/ui';
import { MintMeters, SiteLink } from './components';

export const NAV: ReadonlyArray<{ to: string; label: string; route: Route }> = [
  { to: '/', label: 'Home', route: 'home' },
  { to: '/about', label: 'About', route: 'about' },
  { to: '/collection', label: 'The Collection', route: 'collection' },
  { to: '/how-it-works', label: 'Mint Process', route: 'how' },
  { to: '/manifesto', label: 'Manifesto', route: 'manifesto' },
  { to: '/comic', label: 'The Comic', route: 'comic' },
  { to: '/club', label: 'The Club', route: 'club' },
  { to: '/explorer', label: 'The Register', route: 'explorer' },
  { to: '/review', label: 'Member review', route: 'review' },
];

const Svg = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    {children}
  </svg>
);

export const Icon = {
  rocket: () => (
    <Svg>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M9 12a13 13 0 0 1 11-9 13 13 0 0 1-9 11l-2-2z" />
      <path d="M9 12H5l2-4h4M12 15v4l4-2v-4" />
    </Svg>
  ),
  cart: () => (
    <Svg>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.5 12h11L21 7H6" />
    </Svg>
  ),
  menu: () => (
    <Svg>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  ),
  close: () => (
    <Svg>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  up: () => (
    <Svg>
      <path d="M6 15l6-6 6 6" />
    </Svg>
  ),
  telegram: (label?: string) => (
    <Svg {...(label ? { label } : {})}>
      <path d="M21 4L3 11l6 2 2 6 3-4 5 4z" />
    </Svg>
  ),
  x: (label?: string) => (
    <Svg {...(label ? { label } : {})}>
      <path d="M4 4l16 16M20 4L4 20" />
    </Svg>
  ),
  instagram: (label?: string) => (
    <Svg {...(label ? { label } : {})}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
    </Svg>
  ),
};

export function LogoMark({ size = 30 }: { size?: number }) {
  // A green gem: the club's mark in the live header.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo-mark">
      <path d="M16 2l12 9-12 19L4 11z" fill="#2efc86" />
      <path d="M4 11h24L16 30z" fill="#1bb865" />
      <path d="M10 11l6-9 6 9z" fill="#8dffc0" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      degent<span className="wordmark__club">.club</span>
    </span>
  );
}

function useScrollProgress(): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    const on = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setP(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return p;
}

/** Slide-out menu: a modal dialog (Escape closes, focus is trapped and returned to the toggle). */
function NavDrawer({ open, onClose, route }: { open: boolean; onClose: () => void; route: Route }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('button, a')?.focus();
  }, [open]);
  if (!open) return null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('a, button')];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  return (
    <div className="drawer" onKeyDown={onKey}>
      <button type="button" className="drawer__backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div className="drawer__panel" role="dialog" aria-modal="true" aria-label="Site menu" id="site-menu" ref={panel}>
        <div className="drawer__top">
          <Wordmark />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close menu">
            <Icon.close />
          </button>
        </div>
        <nav aria-label="Site">
          <ul className="drawer__links">
            {NAV.map((n) => (
              <li key={n.to} onClick={onClose}>
                <SiteLink to={n.to} className={`drawer__link ${route === n.route ? 'is-on' : ''}`} aria-current={route === n.route ? 'page' : undefined}>
                  <span className="drawer__dot" aria-hidden="true" />
                  {n.label}
                </SiteLink>
              </li>
            ))}
          </ul>
        </nav>
        <div onClick={onClose}>
          <SiteLink to="/mint" className="btn btn--primary drawer__cta">
            Mint Now!
          </SiteLink>
        </div>
      </div>
    </div>
  );
}

export function SiteHeader({ route }: { route: Route }) {
  const { state, dispatch, app } = useMint();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const progress = useScrollProgress();
  const w = state.wallet;
  const locked = state.step === 'pay' && state.pay.phase !== 'idle' && state.pay.phase !== 'error';
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <>
      <header className="site-header">
        <div className="site-header__inner">
          <SiteLink to="/" className="site-header__brand" aria-label="degent.club home">
            <LogoMark />
            <Wordmark />
          </SiteLink>
          <MintMeters compact />
          <div className="site-header__actions">
            {w ? (
              <span className="chip" title={w.ordinals.address}>
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
            <SiteLink to="/mint" className="btn btn--primary btn--sm" aria-current={route === 'mint' ? 'page' : undefined}>
              <Icon.rocket /> Mint
            </SiteLink>
            <a href={app.buyUrl} className="btn btn--dark btn--sm" target="_blank" rel="noopener noreferrer">
              <Icon.cart /> Buy<span className="sr-only"> on the marketplace (opens in a new tab)</span>
            </a>
            <button
              ref={toggle}
              type="button"
              className="icon-btn"
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => setOpen(true)}
            >
              <Icon.menu />
            </button>
          </div>
        </div>
        <div className="scroll-progress" aria-hidden="true" style={{ transform: `scaleX(${progress})` }} />
      </header>
      <NavDrawer open={open} onClose={close} route={route} />
    </>
  );
}

export function SocialLinks({ className }: { className?: string }) {
  const { app } = useMint();
  const s = app.socials;
  return (
    <ul className={className} aria-label="Socials">
      {s.telegram ? (
        <li>
          <a href={s.telegram} target="_blank" rel="noopener noreferrer" className="icon-btn">
            {Icon.telegram('Telegram')}
          </a>
        </li>
      ) : null}
      {s.x ? (
        <li>
          <a href={s.x} target="_blank" rel="noopener noreferrer" className="icon-btn">
            {Icon.x('X (Twitter)')}
          </a>
        </li>
      ) : null}
      {s.instagram ? (
        <li>
          <a href={s.instagram} target="_blank" rel="noopener noreferrer" className="icon-btn">
            {Icon.instagram('Instagram')}
          </a>
        </li>
      ) : null}
    </ul>
  );
}

export function SocialRail() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 600);
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <aside className="social-rail" aria-label="Follow the club">
      <SocialLinks className="social-rail__list" />
      {show ? (
        <button
          type="button"
          className="icon-btn social-rail__top"
          aria-label="Back to top"
          onClick={() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            document.querySelector<HTMLElement>('#main h1')?.focus();
          }}
        >
          <Icon.up />
        </button>
      ) : null}
    </aside>
  );
}

export function SiteFooter() {
  const { app, services } = useMint();
  return (
    <footer className="site-footer">
      <div className="site-footer__grid">
        <div>
          <p className="site-footer__brand">
            <LogoMark size={24} /> <Wordmark />
          </p>
          <p className="muted">A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.</p>
          <SocialLinks className="site-footer__socials" />
        </div>
        <nav aria-label="Quick links">
          <h2 className="site-footer__title">Quick Links</h2>
          <ul className="plain">
            {NAV.slice(0, 7).map((n) => (
              <li key={n.to}>
                <SiteLink to={n.to}>{n.label}</SiteLink>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <h2 className="site-footer__title">Newsletter</h2>
          <p className="small muted">Stay updated with our latest news and drops.</p>
          {/* TODO(newsletter): the mint API has no newsletter subscription endpoint yet (only per-order
              notifications). Needs a contract-first route backed by @bsh/notify's email channel; roadmap p3.30. */}
          <form className="newsletter" aria-describedby="newsletter-soon" onSubmit={(e) => e.preventDefault()}>
            <label className="sr-only" htmlFor="newsletter-name">
              Name
            </label>
            <input id="newsletter-name" className="input" placeholder="Name" disabled autoComplete="name" />
            <label className="sr-only" htmlFor="newsletter-email">
              E-mail
            </label>
            <input id="newsletter-email" className="input" type="email" placeholder="E-mail" disabled autoComplete="email" />
            <button type="submit" className="btn btn--primary btn--sm" disabled>
              Subscribe
            </button>
          </form>
          <p id="newsletter-soon" className="small muted">
            Sign-up opens soon. Minting? Get your own order's news on its Track page (“Notify me”).
          </p>
        </div>
      </div>
      <p className="small muted site-footer__legal">
        Non-custodial by design: your reveal key never leaves your browser. Network <span className="mono">{app.network}</span>
        {services.mode === 'demo' ? ' · demo mode' : ''}.
      </p>
    </footer>
  );
}
