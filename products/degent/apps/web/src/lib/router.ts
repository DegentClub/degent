/**
 * A tiny hash router (no router library). Routes:
 *
 *   #/                       the mint (welcome)            #/studio             Artist Studio
 *   #/gallery[?page=n&artist=addr]  the gallery           #/studio/upload      hang a new Degent
 *   #/gallery/:id            one artwork                  #/studio/royalties   what the artist was paid
 *   #/mint[/:artworkId]      the mint wizard, optionally with a studio artwork prefilled
 *
 * `useRoute` subscribes to `hashchange`; `navigate` sets the hash and notifies synchronously so the
 * UI updates even where the browser's event is delayed (jsdom) or the hash did not change.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'gallery'; page: number; artist: string | null }
  | { name: 'artwork'; id: string }
  | { name: 'studio' }
  | { name: 'studio-upload' }
  | { name: 'studio-royalties' }
  | { name: 'mint'; artworkId: string | null }
  | { name: 'not-found'; path: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  if (head === 'gallery') {
    if (second === undefined) {
      const page = Number(query.get('page') ?? '1');
      const artist = query.get('artist');
      return { name: 'gallery', page: Number.isInteger(page) && page >= 1 ? page : 1, artist: artist && artist.length > 0 ? artist : null };
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
    case 'gallery': {
      const q = new URLSearchParams();
      if (r.page > 1) q.set('page', String(r.page));
      if (r.artist) q.set('artist', r.artist);
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

/** True for the routes that render the mint wizard. */
export function isMintRoute(r: Route): boolean {
  return r.name === 'home' || r.name === 'mint';
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

/** Go to a hash route (`#/gallery`, or a Route). Safe to call from event handlers and effects. */
export function navigate(to: string | Route): void {
  const path = typeof to === 'string' ? to : routePath(to);
  if (typeof window !== 'undefined' && window.location.hash !== path) window.location.hash = path;
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
