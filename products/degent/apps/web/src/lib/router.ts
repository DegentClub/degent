/**
 * A tiny hash router (no router library). Routes (README "Routes"):
 *
 *   #/                                  Home                  #/studio             Artist Studio
 *   #/collection[?page=n&per=n]         certified members     #/studio/upload      hang a new Degent
 *   #/collection/:n[?per=n]             …with DEGENT #n open  #/studio/royalties   what the artist was paid
 *   #/gallery[?page&artist&available]    the Studio gallery    #/mint-process       Minting Rules
 *   #/gallery/:id                       one artwork           #/comic, #/about, #/manifesto
 *   #/mint[/:artworkId]                 the mint wizard       #/blog, #/blog/:slug (WordPress slugs kept)
 *   #/artists/:address                  an artist's page
 *
 * `useRoute` subscribes to `hashchange`; `navigate` sets the hash and notifies synchronously so the
 * UI updates even where the browser's event is delayed (jsdom) or the hash did not change.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  /** `item` is the 1-based `DEGENT #n` whose lightbox is open; `perPage` null = the default page size. */
  | { name: 'collection'; page: number; perPage: number | null; item: number | null }
  | { name: 'mint-process' }
  | { name: 'comic' }
  | { name: 'about' }
  | { name: 'manifesto' }
  | { name: 'blog' }
  | { name: 'blog-post'; slug: string }
  | { name: 'artist'; address: string }
  /** `available` undefined = no filter; `true` = only mintable (not sold out); `false` = only sold out (studio contract). */
  | { name: 'gallery'; page: number; artist: string | null; available?: boolean }
  | { name: 'artwork'; id: string }
  | { name: 'studio' }
  | { name: 'studio-upload' }
  | { name: 'studio-royalties' }
  | { name: 'mint'; artworkId: string | null }
  | { name: 'not-found'; path: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BLOG_SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
/** Shape only (bech32/bech32m or base58), like the certify contract's BitcoinAddress. */
const ADDRESS = /^(?:(?:bc1|tb1|bcrt1)[02-9ac-hj-np-z]{6,87}|(?:BC1|TB1|BCRT1)[02-9AC-HJ-NP-Z]{6,87}|[13mn2][1-9A-HJ-NP-Za-km-z]{25,34})$/;
/** Page sizes the collection toolbar offers. */
export const PER_PAGE_OPTIONS = [20, 40, 60, 100] as const;

const positiveInt = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || !/^\d{1,7}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
};

const SIMPLE: Record<string, Route> = {
  'mint-process': { name: 'mint-process' },
  // The live site's "Learn How" / Minting Process page; the spec's IA calls it /how-it-works.
  'how-it-works': { name: 'mint-process' },
  comic: { name: 'comic' },
  about: { name: 'about' },
  manifesto: { name: 'manifesto' },
};

export function parseRoute(hash: string): Route {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === '/') return { name: 'home' };
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const qIdx = raw.indexOf('?');
  const path = (qIdx >= 0 ? raw.slice(0, qIdx) : raw).replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  const parts = path.split('/').slice(1).map((p) => decodeURIComponent(p));
  const [head, second, third] = parts;
  if (head === '' || head === undefined) return { name: 'home' };
  if (head in SIMPLE && second === undefined) return SIMPLE[head]!;
  if (head === 'collection') {
    const per = positiveInt(query.get('per'));
    const perPage = per !== null && (PER_PAGE_OPTIONS as readonly number[]).includes(per) ? per : null;
    if (second === undefined) return { name: 'collection', page: positiveInt(query.get('page')) ?? 1, perPage, item: null };
    const item = positiveInt(second);
    if (third === undefined && item !== null) return { name: 'collection', page: 1, perPage, item };
    return { name: 'not-found', path };
  }
  if (head === 'blog') {
    if (second === undefined) return { name: 'blog' };
    if (third === undefined && BLOG_SLUG.test(second)) return { name: 'blog-post', slug: second };
    return { name: 'not-found', path };
  }
  if (head === 'artists') {
    if (second !== undefined && third === undefined && ADDRESS.test(second)) return { name: 'artist', address: second };
    return { name: 'not-found', path };
  }
  if (head === 'gallery') {
    if (second === undefined) {
      const page = Number(query.get('page') ?? '1');
      const artist = query.get('artist');
      const rawAvailable = query.get('available');
      const available = rawAvailable === '1' || rawAvailable === 'true' ? true : rawAvailable === '0' || rawAvailable === 'false' ? false : undefined;
      return { name: 'gallery', page: Number.isInteger(page) && page >= 1 ? page : 1, artist: artist && artist.length > 0 ? artist : null, ...(available !== undefined ? { available } : {}) };
    }
    if (third === undefined && ID.test(second)) return { name: 'artwork', id: second };
    return { name: 'not-found', path };
  }
  if (head === 'studio') {
    if (second === undefined) return { name: 'studio' };
    if (second === 'upload' && third === undefined) return { name: 'studio-upload' };
    if (second === 'royalties' && third === undefined) return { name: 'studio-royalties' };
    return { name: 'not-found', path };
  }
  if (head === 'mint') {
    if (second === undefined) return { name: 'mint', artworkId: null };
    if (third === undefined && ID.test(second)) return { name: 'mint', artworkId: second };
    return { name: 'not-found', path };
  }
  return { name: 'not-found', path };
}

/** The hash for a route, e.g. `#/gallery/art_1`. */
export function routePath(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'collection': {
      const q = new URLSearchParams();
      if (r.item === null && r.page > 1) q.set('page', String(r.page));
      if (r.perPage !== null) q.set('per', String(r.perPage));
      const s = q.toString();
      const base = r.item !== null ? `#/collection/${r.item}` : '#/collection';
      return s ? `${base}?${s}` : base;
    }
    case 'mint-process':
    case 'comic':
    case 'about':
    case 'manifesto':
    case 'blog':
      return `#/${r.name}`;
    case 'blog-post':
      return `#/blog/${encodeURIComponent(r.slug)}`;
    case 'artist':
      return `#/artists/${encodeURIComponent(r.address)}`;
    case 'gallery': {
      const q = new URLSearchParams();
      if (r.page > 1) q.set('page', String(r.page));
      if (r.artist) q.set('artist', r.artist);
      if (r.available !== undefined) q.set('available', r.available ? '1' : '0');
      const s = q.toString();
      return s ? `#/gallery?${s}` : '#/gallery';
    }
    case 'artwork':
      return `#/gallery/${encodeURIComponent(r.id)}`;
    case 'studio':
      return '#/studio';
    case 'studio-upload':
      return '#/studio/upload';
    case 'studio-royalties':
      return '#/studio/royalties';
    case 'mint':
      return r.artworkId ? `#/mint/${encodeURIComponent(r.artworkId)}` : '#/mint';
    case 'not-found':
      return `#${r.path}`;
  }
}

/** True for the routes that render the mint wizard (`#/` is the Home page since the site rebuild). */
export function isMintRoute(r: Route): boolean {
  return r.name === 'mint';
}

const listeners = new Set<() => void>();
let installed = false;

function notify(): void {
  for (const l of [...listeners]) l();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('hashchange', notify);
}

export function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

/**
 * Go to a hash route (`#/gallery`, or a Route). Safe to call from event handlers and effects.
 * `replace: true` swaps the current history entry (lightbox prev/next, toolbar tweaks) instead of
 * adding one per step.
 */
export function navigate(to: string | Route, opts: { replace?: boolean } = {}): void {
  const path = typeof to === 'string' ? to : routePath(to);
  if (typeof window !== 'undefined' && window.location.hash !== path) {
    if (opts.replace) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${path}`);
    else window.location.hash = path;
  }
  notify();
}

function subscribe(cb: () => void): () => void {
  install();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The current route, re-rendered on every hash change. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return parseRoute(hash);
}
