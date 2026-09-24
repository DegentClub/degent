import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from '../router';
import { copyVisible, useSite } from '../context';
import { Icon } from '../components/Icons';

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

export function primaryNav(show: { about: boolean; manifesto: boolean }): NavItem[] {
  const items: Array<NavItem | null> = [
    { to: '/', label: 'Home', icon: <Icon.home /> },
    show.about ? { to: '/about', label: 'About', icon: <Icon.info /> } : null,
    { to: '/collection', label: 'The Collection', icon: <Icon.grid /> },
    { to: '/how-it-works', label: 'Mint Process', icon: <Icon.steps /> },
    show.manifesto ? { to: '/manifesto', label: 'Manifesto', icon: <Icon.scroll /> } : null,
    { to: '/blog', label: 'Blog', icon: <Icon.pen /> },
  ];
  return items.filter((x): x is NavItem => x !== null);
}

export const MORE_NAV: NavItem[] = [
  { to: '/atelier', label: 'The Atelier', icon: <Icon.brush /> },
  { to: '/comic', label: 'The Comic', icon: <Icon.book /> },
  { to: '/club', label: 'The Club', icon: <Icon.crown /> },
];

/** Right slide-out navigation (modal dialog: Esc closes, focus is kept inside, returns to the opener). */
export function NavPanel({ open, onClose, returnFocus }: { open: boolean; onClose(): void; returnFocus: () => HTMLElement | null }) {
  const { app } = useSite();
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      panel.current?.querySelector<HTMLElement>('a, button')?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab' && panel.current) {
          const f = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
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
      document.documentElement.classList.add('is-locked');
      return () => {
        document.removeEventListener('keydown', onKey);
        document.documentElement.classList.remove('is-locked');
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      returnFocus()?.focus();
    }
    return undefined;
  }, [open, onClose, returnFocus]);

  const items = primaryNav({ about: copyVisible(app, 'about'), manifesto: copyVisible(app, 'manifesto') });
  return (
    <div className={`navpanel ${open ? 'is-open' : ''}`} hidden={!open}>
      <div className="navpanel__scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panel} className="navpanel__sheet" role="dialog" aria-modal="true" aria-label="Site menu" id="site-menu">
        <div className="navpanel__head">
          <span className="navpanel__title">Menu</span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close menu">
            <Icon.close />
          </button>
        </div>
        <nav aria-label="Primary">
          <ul className="navpanel__list">
            {items.map((it) => (
              <li key={it.to}>
                <Link to={it.to} className="navpanel__link" onClick={onClose}>
                  <span className="navpanel__icon">{it.icon}</span>
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="navpanel__group">More from the club</p>
          <ul className="navpanel__list">
            {MORE_NAV.map((it) => (
              <li key={it.to}>
                <Link to={it.to} className="navpanel__link" onClick={onClose}>
                  <span className="navpanel__icon">{it.icon}</span>
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Link to="/mint" className="cta cta--gradient cta--block" onClick={onClose}>
          <span>Mint Now!</span>
          <span className="cta__icon">
            <Icon.rocket />
          </span>
        </Link>
      </div>
    </div>
  );
}
