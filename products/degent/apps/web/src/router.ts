/**
 * Tiny path router (no dependency): the site pages from the site spec's target information architecture plus
 * the mint and member pages. `matchRoute` also extracts `/collection/:n` and `/track/:id` parameters.
 */
import { useEffect, useState } from 'react';
import { CHARTER_SIZE } from '@bsh/degent-mint-sdk';

export type Route =
  | 'home'
  | 'mint'
  | 'collection'
  | 'degent'
  | 'comic'
  | 'how'
  | 'club'
  | 'manifesto'
  | 'about'
  | 'review'
  | 'explorer'
  | 'verify'
  | 'track'
  | 'notfound';

export interface RouteMatch {
  route: Route;
  /** `/collection/:n` */
  n?: number;
  /** `/track/:id` */
  id?: string;
}

const STATIC: Record<string, Route> = {
  '/': 'home',
  '/mint': 'mint',
  '/collection': 'collection',
  '/comic': 'comic',
  '/how-it-works': 'how',
  '/club': 'club',
  '/manifesto': 'manifesto',
  '/about': 'about',
  '/review': 'review',
  '/explorer': 'explorer',
  '/verify': 'verify',
};

export function matchRoute(pathname: string): RouteMatch {
  const p = pathname.replace(/\/+$/, '') || '/';
  const fixed = STATIC[p];
  if (fixed) return { route: fixed };
  if (p.startsWith('/explorer/')) return { route: 'explorer' };
  const degent = /^\/collection\/(\d{1,5})$/.exec(p);
  if (degent) {
    const n = Number(degent[1]);
    return n >= 1 && n <= CHARTER_SIZE ? { route: 'degent', n } : { route: 'notfound' };
  }
  const track = /^\/track\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (track) return { route: 'track', id: track[1]! };
  return { route: 'notfound' };
}

export function routeFor(pathname: string): Route {
  return matchRoute(pathname).route;
}

export const ROUTE_PATHS: Record<Exclude<Route, 'degent' | 'track' | 'notfound'>, string> = {
  home: '/',
  mint: '/mint',
  collection: '/collection',
  comic: '/comic',
  how: '/how-it-works',
  club: '/club',
  manifesto: '/manifesto',
  about: '/about',
  review: '/review',
  explorer: '/explorer',
  verify: '/verify',
};

/** Current pathname, following history navigation. `override` pins it (tests). */
export function usePathname(override?: string): string {
  const [path, setPath] = useState(() => override ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  // A pinned path (tests) still follows in-app navigation once it happens.
  const [pinned, setPinned] = useState(override);
  useEffect(() => {
    if (override === undefined) return;
    const on = () => setPinned(undefined);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, [override]);
  return pinned ?? path;
}

/** In-app navigation without a reload (keeps `?demo=1` and other params). */
export function navigate(to: string): void {
  const url = new URL(to, window.location.href);
  if (!url.search) url.search = window.location.search;
  window.history.pushState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) window.scrollTo({ top: 0 });
}

/** Click handler for internal links: plain clicks navigate in-app, modified clicks open normally. */
export function onInternalClick(to: string) {
  return (e: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    navigate(to);
  };
}
