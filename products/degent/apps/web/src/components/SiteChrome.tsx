/** The rest of the global chrome: the floating social rail, back-to-top and the footer with the newsletter. */
import { useId, useState, type FormEvent } from 'react';
import { useMint } from '../flow/context';
import { scrollToTop, useScroll } from '../lib/scroll';
import { COPY, SOCIAL, TAGLINE } from '../lib/site';
import { GemMark, Icon } from './Icons';
import { Link } from './Link';
import { Wordmark } from './SiteHeader';

export function SocialRail() {
  return (
    <aside className="social-rail" aria-label="degent.club elsewhere">
      <a href={SOCIAL.telegram} target="_blank" rel="noopener noreferrer" aria-label="Telegram (opens in a new tab)">
        <Icon.Telegram />
      </a>
      <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label="X / Twitter (opens in a new tab)">
        <Icon.X />
      </a>
      {SOCIAL.instagram ? (
        <a href={SOCIAL.instagram} target="_blank" rel="noopener noreferrer" aria-label="Instagram (opens in a new tab)">
          <Icon.Instagram />
        </a>
      ) : (
        // TODO(copy): the Instagram URL was not captured from the live site.
        <span className="social-rail__todo" role="img" aria-label="Instagram: link not available yet (TODO)" title="Instagram: TODO(copy), link not captured">
          <Icon.Instagram />
        </span>
      )}
    </aside>
  );
}

export function BackToTop() {
  const { y } = useScroll();
  const shown = y > 600;
  return (
    <button type="button" className={['to-top', shown ? 'is-shown' : ''].filter(Boolean).join(' ')} aria-label="Back to top" tabIndex={shown ? 0 : -1} onClick={scrollToTop}>
      <Icon.ChevronUp />
    </button>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Newsletter (site spec footer). The old form posted to WordPress; the rebuild will use `@bsh/notify`
 * email subscriptions, which are not wired yet, so this form sends NOTHING and says so plainly.
 */
export function Newsletter() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const nameId = useId();
  const emailId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setMessage({ tone: 'bad', text: 'That e-mail address does not look right.' });
      return;
    }
    setMessage({
      tone: 'info',
      text: 'Newsletter sign-up is coming soon. Nothing was sent and you are not subscribed yet; follow us on X or Telegram in the meantime.',
    });
  };
  return (
    <form className="newsletter" onSubmit={submit} noValidate aria-labelledby={`${nameId}-h`}>
      <h2 id={`${nameId}-h`} className="footer__h">
        Newsletter
      </h2>
      <p className="muted small">{COPY.newsletter}</p>
      <label htmlFor={nameId} className="sr-only">
        Name
      </label>
      <input id={nameId} className="input" placeholder="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor={emailId} className="sr-only">
        E-mail
      </label>
      <input id={emailId} className="input" type="email" placeholder="E-mail" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit" className="btn btn--primary btn--sm">
        Subscribe
      </button>
      <p role="status" className={['newsletter__msg', message?.tone === 'bad' ? 'is-bad' : ''].filter(Boolean).join(' ')}>
        {message?.text ?? ''}
      </p>
    </form>
  );
}

export function SiteFooter() {
  const { app, services } = useMint();
  return (
    <footer className="site-footer">
      <div className="container site-footer__grid">
        <div className="site-footer__brand">
          <Link to={{ name: 'home' }} className="brand" aria-label="degent.club home">
            <GemMark />
            <Wordmark />
          </Link>
          <p className="muted">{TAGLINE}</p>
          <p className="row">
            <a className="btn btn--dark btn--sm" href={SOCIAL.x} target="_blank" rel="noopener noreferrer">
              <Icon.X /> X<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a className="btn btn--telegram btn--sm" href={SOCIAL.telegram} target="_blank" rel="noopener noreferrer">
              <Icon.Telegram /> Telegram<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
        <nav aria-label="Quick links" className="site-footer__links">
          <h2 className="footer__h">Quick Links</h2>
          <ul className="plainlist">
            <li>
              <Link to={{ name: 'home' }}>Home</Link>
            </li>
            <li>
              <Link to={{ name: 'about' }}>About</Link>
            </li>
            <li>
              <Link to={{ name: 'mint-process' }}>Minting Process</Link>
            </li>
            <li>
              <Link to={{ name: 'collection', page: 1, perPage: null, item: null }}>The Collection</Link>
            </li>
            <li>
              <Link to={{ name: 'gallery', page: 1, artist: null }}>Gallery</Link>
            </li>
            <li>
              <Link to={{ name: 'comic' }}>The Comic</Link>
            </li>
            <li>
              <Link to={{ name: 'manifesto' }}>Manifesto</Link>
            </li>
            <li>
              <Link to={{ name: 'blog' }}>Blog</Link>
            </li>
            <li>
              <Link to={{ name: 'studio' }}>Artist Studio</Link>
            </li>
          </ul>
        </nav>
        <Newsletter />
      </div>
      <div className="container site-footer__legal">
        <p className="small muted">
          Non-custodial by design: your one-time reveal key stays with you (in your recovery bundle, never on our server), the
          server only ever holds a half-signed transaction that pays <em>you</em>, and artists are paid by minters directly, in
          the funding transaction. Counts are certified by block.space.
        </p>
        <p className="small muted">
          Network: <span className="mono">{app.network}</span>
          {services.mode === 'demo' ? ' · demo mode' : ''}
        </p>
      </div>
    </footer>
  );
}
