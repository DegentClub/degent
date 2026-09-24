/**
 * A tiny history-API router (no framework). Paths are parsed into a typed `Route`; `navigate`
 * pushes state and notifies subscribers; `<Link>` intercepts plain left-clicks. The `demo` query
 * parameter survives every navigation so `?demo=1` stays on while browsing.
 *
 * Static hosting needs an SPA fallback (every unknown path serves index.html); `vite preview` does
 * this out of the box. Trailing slashes (the WordPress URLs: `/collection/`, `/blog/<slug>/`) are
 * accepted.
 */
import { createContext, useCallback, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'collection'; n: number | null }
  | { name: 'mint' }
  | { name: 'atelier' }
  | { name: 'comic' }
  | { name: 'manifesto' }
  | { name: 'about' }
  | { name: 'how' }
  | { name: 'blog' }
  | { name: 'post'; slug: string }
  | { name: 'club' }
  | { name: 'notfound'; path: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export function parseRoute(pathname: string): Route {
  let path = pathname.replace(/\/{2,}/g, '/');
  try {
    path = decodeURI(path);
  } catch {
    /* keep raw */
  }
  const parts = path.split('/').filter(Boolean);
  const [a, b, ...rest] = parts;
  if (parts.length === 0) return { name: 'home' };
  if (rest.length > 0) return { name: 'notfound', path };
  switch (a) {
    case 'collection': {
      if (b === undefined) return { name: 'collection', n: null };
      const n = /^\d{1,6}$/.test(b) ? Number(b) : NaN;
      return Number.isInteger(n) && n >= 1 ? { name: 'collection', n } : { name: 'notfound', path };
    }
    case 'blog':
      if (b === undefined) return { name: 'blog' };
      return SLUG.test(b) ? { name: 'post', slug: b } : { name: 'notfound', path };
    case 'mint':
    case 'atelier':
    case 'comic':
    case 'manifesto':
    case 'about':
    case 'club':
      return b === undefined ? { name: a } : { name: 'notfound', path };
    case 'how-it-works':
    case 'mint-process':
      return b === undefined ? { name: 'how' } : { name: 'notfound', path };
    default:
      return { name: 'notfound', path };
  }
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'home':
      return '/';
    case 'collection':
      return r.n === null ? '/collection' : `/collection/${r.n}`;
    case 'how':
      return '/how-it-works';
    case 'post':
      return `/blog/${r.slug}`;
    case 'notfound':
      return r.path;
    default:
      return `/${r.name}`;
  }
}

// ------------------------------------------------------------------ history

export interface HistoryLike {
  location: { pathname: string; search: string; hash: string };
  push(url: string): void;
  replace(url: string): void;
  subscribe(cb: () => void): () => void;
}

export function browserHistory(): HistoryLike {
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  window.addEventListener('popstate', emit);
  return {
    get location() {
      return window.location;
    },
    push(url) {
      window.history.pushState(null, '', url);
      emit();
    },
    replace(url) {
      window.history.replaceState(null, '', url);
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** In-memory history for tests. */
export function memoryHistory(initial = '/'): HistoryLike & { entries: string[] } {
  const listeners = new Set<() => void>();
  const entries = [initial];
  const loc = () => {
    const u = new URL(entries[entries.length - 1]!, 'http://x');
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  };
  let cached = loc();
  const emit = () => {
    cached = loc();
    listeners.forEach((l) => l());
  };
  return {
    entries,
    get location() {
      return cached;
    },
    push(url) {
      entries.push(url);
      emit();
    },
    replace(url) {
      entries[entries.length - 1] = url;
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Keep only the params that must survive navigation (`demo`). */
export function carrySearch(search: string): string {
  const cur = new URLSearchParams(search);
  const out = new URLSearchParams();
  const demo = cur.get('demo');
  if (demo) out.set('demo', demo);
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function hrefFor(to: string, currentSearch: string): string {
  const [path, query = ''] = to.split('?');
  const carried = new URLSearchParams(carrySearch(currentSearch));
  for (const [k, v] of new URLSearchParams(query)) carried.set(k, v);
  const s = carried.toString();
  return `${path}${s ? `?${s}` : ''}`;
}

// ------------------------------------------------------------------ React

interface RouterValue {
  history: HistoryLike;
  route: Route;
  search: string;
  navigate(to: string, opts?: { replace?: boolean; keepScroll?: boolean }): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ history, children }: { history: HistoryLike; children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    history.subscribe,
    () => `${history.location.pathname}${history.location.search}`,
    () => `${history.location.pathname}${history.location.search}`,
  );
  const url = new URL(snapshot, 'http://x');
  const route = parseRoute(url.pathname);
  const navigate = useCallback(
    (to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) => {
      const href = hrefFor(to, history.location.search);
      if (opts.replace) history.replace(href);
      else history.push(href);
      if (!opts.keepScroll && typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        try {
          window.scrollTo({ top: 0 });
        } catch {
          /* jsdom */
        }
      }
    },
    [history],
  );
  return <RouterContext.Provider value={{ history, route, search: url.search, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error('useRouter must be used inside <RouterProvider>');
  return v;
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; keepScroll?: boolean; replace?: boolean };

export function Link({ to, keepScroll, replace, onClick, children, ...rest }: LinkProps) {
  const { navigate, search, route } = useRouter();
  const href = hrefFor(to, search);
  const current = routePath(route) === to.split('?')[0];
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== '_self') return;
    e.preventDefault();
    navigate(to, { ...(keepScroll ? { keepScroll } : {}), ...(replace ? { replace } : {}) });
  };
  return (
    <a href={href} onClick={handle} aria-current={current ? 'page' : undefined} {...rest}>
      {children}
    </a>
  );
}
