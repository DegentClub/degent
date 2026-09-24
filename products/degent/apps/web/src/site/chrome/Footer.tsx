import { useEffect, useState } from 'react';
import { Link } from '../router';
import { copyVisible, useSite } from '../context';
import { Icon, LogoMark } from '../components/Icons';
import { Wordmark } from './Header';
import { Newsletter } from './Newsletter';
import { MORE_NAV, primaryNav } from './NavPanel';

export function Socials({ className = '' }: { className?: string }) {
  const { app } = useSite();
  const links = [
    { href: app.social.telegram, label: 'Telegram', icon: <Icon.telegram /> },
    { href: app.social.x, label: 'X (Twitter)', icon: <Icon.x /> },
    ...(app.social.instagram ? [{ href: app.social.instagram, label: 'Instagram', icon: <Icon.instagram /> }] : []),
  ];
  return (
    <ul className={`socials ${className}`.trim()} aria-label="degent.club on social media">
      {links.map((l) => (
        <li key={l.label}>
          <a href={l.href} target="_blank" rel="noopener noreferrer" className="socials__a" aria-label={`${l.label} (opens in a new tab)`}>
            {l.icon}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Floating left social rail (desktop) + back-to-top (bottom-left, after scrolling). */
export function Rail() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 600);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const toTop = () => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
  };
  return (
    <>
      <div className="rail">
        <Socials />
      </div>
      <button type="button" className={`totop ${show ? 'is-on' : ''}`} onClick={toTop} aria-label="Back to top" tabIndex={show ? 0 : -1} aria-hidden={!show}>
        <Icon.chevronUp />
      </button>
    </>
  );
}

export function Footer() {
  const { app, site } = useSite();
  const links = [...primaryNav({ about: copyVisible(app, 'about'), manifesto: copyVisible(app, 'manifesto') }), ...MORE_NAV, { to: '/mint', label: 'Mint', icon: null }];
  return (
    <footer className="site-footer">
      <div className="container site-footer__grid">
        <div className="site-footer__brand">
          <Link to="/" className="brand" aria-label="degent.club home">
            <LogoMark />
            <Wordmark />
          </Link>
          <p>A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.</p>
          <Socials />
        </div>
        <nav className="site-footer__links" aria-label="Quick links">
          <h2 className="site-footer__h">Quick Links</h2>
          <ul>
            {links.map((l) => (
              <li key={l.to}>
                <Link to={l.to}>{l.label === 'Mint Process' ? 'Minting Process' : l.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="site-footer__news">
          <h2 className="site-footer__h">Newsletter</h2>
          <Newsletter />
        </div>
      </div>
      <div className="container site-footer__base">
        <span>© Decentralized Gentlemen Club · Built on Bitcoin</span>
        <span className="muted">
          Collection stats: block.space certification{site.mode === 'demo' ? ' (demo: bundled manifest)' : ''}
        </span>
      </div>
    </footer>
  );
}
