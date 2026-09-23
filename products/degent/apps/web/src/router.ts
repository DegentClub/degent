/** Tiny path router: the mint wizard at `/`, plus the member and public pages. No dependency needed. */
import { useEffect, useState } from 'react';

export type Route = 'mint' | 'review' | 'explorer' | 'verify';

export function routeFor(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/review') return 'review';
  if (p === '/explorer' || p.startsWith('/explorer/')) return 'explorer';
  if (p === '/verify') return 'verify';
  return 'mint';
}

export const ROUTE_PATHS: Record<Route, string> = { mint: '/', review: '/review', explorer: '/explorer', verify: '/verify' };

/** Current pathname, following history navigation. `override` pins it (tests). */
export function usePathname(override?: string): string {
  const [path, setPath] = useState(() => override ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));
  useEffect(() => {
    if (override !== undefined) return;
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, [override]);
  return override ?? path;
}

/** In-app navigation without a reload (keeps `?demo=1` and other params). */
export function navigate(to: string): void {
  const url = new URL(to, window.location.href);
  url.search = window.location.search;
  window.history.pushState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}
