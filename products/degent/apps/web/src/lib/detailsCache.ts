/**
 * ord details for the lightbox, fetched once per inscription and shared. The lightbox prefetches the
 * neighbours of the open Degent (and preloads their images), so prev/next shows complete details
 * immediately instead of flashing "LOADING…" (site spec, "Known defects").
 */
import type { OrdApi, OrdInscription } from '../services/ordApi';

export interface DetailsCache {
  /** Settled value: details, `null` when ord could not supply them, `undefined` when not fetched yet. */
  peek(id: string): OrdInscription | null | undefined;
  get(id: string): Promise<OrdInscription | null>;
  prefetch(ids: readonly string[]): void;
  /** Notified whenever an entry settles. */
  subscribe(cb: () => void): () => void;
}

export function createDetailsCache(ord: OrdApi): DetailsCache {
  const settled = new Map<string, OrdInscription | null>();
  const inflight = new Map<string, Promise<OrdInscription | null>>();
  const listeners = new Set<() => void>();

  const get = (id: string): Promise<OrdInscription | null> => {
    if (settled.has(id)) return Promise.resolve(settled.get(id)!);
    const running = inflight.get(id);
    if (running) return running;
    const p = ord
      .getInscription(id)
      .then(
        (d) => d,
        () => null,
      )
      .then((d) => {
        settled.set(id, d);
        inflight.delete(id);
        for (const l of [...listeners]) l();
        return d;
      });
    inflight.set(id, p);
    return p;
  };

  return {
    peek: (id) => (settled.has(id) ? settled.get(id)! : undefined),
    get,
    prefetch(ids) {
      for (const id of ids) void get(id);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

const preloaded = new Set<string>();

/** Warm the browser's image cache for a URL (no-op outside a browser). */
export function preloadImage(url: string): void {
  if (preloaded.has(url) || typeof Image === 'undefined') return;
  preloaded.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

/** For tests. */
export function preloadedImages(): ReadonlySet<string> {
  return preloaded;
}
