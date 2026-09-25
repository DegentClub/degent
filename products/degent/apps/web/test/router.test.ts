import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { isMintRoute, navigate, parseRoute, routePath, useRoute, type Route } from '../src/lib/router';

describe('hash router: parseRoute', () => {
  it.each<[string, Route]>([
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/gallery', { name: 'gallery', page: 1, artist: null }],
    ['#/gallery/', { name: 'gallery', page: 1, artist: null }],
    ['#/gallery?page=3&artist=bc1pabc', { name: 'gallery', page: 3, artist: 'bc1pabc' }],
    ['#/gallery?page=0', { name: 'gallery', page: 1, artist: null }],
    ['#/gallery/art_demo_chairman', { name: 'artwork', id: 'art_demo_chairman' }],
    ['#/studio', { name: 'studio' }],
    ['#/studio/upload', { name: 'studio-upload' }],
    ['#/studio/royalties', { name: 'studio-royalties' }],
    ['#/mint', { name: 'mint', artworkId: null }],
    ['#/mint/art_1', { name: 'mint', artworkId: 'art_1' }],
    ['#/nowhere', { name: 'not-found', path: '/nowhere' }],
    ['#/gallery/a/b', { name: 'not-found', path: '/gallery/a/b' }],
    ['#/studio/settings', { name: 'not-found', path: '/studio/settings' }],
    ['#/mint/not%20an%20id', { name: 'not-found', path: '/mint/not%20an%20id' }],
    // The site (p6.1)
    ['#/collection', { name: 'collection', page: 1, perPage: null, item: null }],
    ['#/collection?page=7', { name: 'collection', page: 7, perPage: null, item: null }],
    ['#/collection?page=3&per=40', { name: 'collection', page: 3, perPage: 40, item: null }],
    ['#/collection?per=33', { name: 'collection', page: 1, perPage: null, item: null }],
    ['#/collection?page=-2', { name: 'collection', page: 1, perPage: null, item: null }],
    ['#/collection/57', { name: 'collection', page: 1, perPage: null, item: 57 }],
    ['#/collection/57?per=100', { name: 'collection', page: 1, perPage: 100, item: 57 }],
    ['#/collection/0', { name: 'not-found', path: '/collection/0' }],
    ['#/collection/abc', { name: 'not-found', path: '/collection/abc' }],
    ['#/mint-process', { name: 'mint-process' }],
    ['#/how-it-works', { name: 'mint-process' }],
    ['#/comic', { name: 'comic' }],
    ['#/about', { name: 'about' }],
    ['#/manifesto', { name: 'manifesto' }],
    ['#/manifesto/', { name: 'manifesto' }],
    ['#/blog', { name: 'blog' }],
    ['#/blog/degent-chronicles-vol-1', { name: 'blog-post', slug: 'degent-chronicles-vol-1' }],
    ['#/blog/Not_A_Slug', { name: 'not-found', path: '/blog/Not_A_Slug' }],
    ['#/artists/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', { name: 'artist', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }],
    ['#/artists/not-an-address', { name: 'not-found', path: '/artists/not-an-address' }],
    ['#/artists', { name: 'not-found', path: '/artists' }],
    ['#/about/team', { name: 'not-found', path: '/about/team' }],
  ])('%s', (hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected);
  });

  it('routePath round-trips every route', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'gallery', page: 1, artist: null },
      { name: 'gallery', page: 2, artist: 'bc1pabc' },
      { name: 'artwork', id: 'art_x' },
      { name: 'studio' },
      { name: 'studio-upload' },
      { name: 'studio-royalties' },
      { name: 'mint', artworkId: null },
      { name: 'mint', artworkId: 'art_x' },
      { name: 'collection', page: 1, perPage: null, item: null },
      { name: 'collection', page: 4, perPage: 60, item: null },
      { name: 'collection', page: 1, perPage: null, item: 12 },
      { name: 'collection', page: 1, perPage: 40, item: 4112 },
      { name: 'mint-process' },
      { name: 'comic' },
      { name: 'about' },
      { name: 'manifesto' },
      { name: 'blog' },
      { name: 'blog-post', slug: 'a-wordpress-slug' },
      { name: 'artist', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
    ];
    for (const r of routes) expect(parseRoute(routePath(r))).toEqual(r);
    expect(routePath({ name: 'gallery', page: 1, artist: null })).toBe('#/gallery');
    expect(routePath({ name: 'mint', artworkId: 'art_x' })).toBe('#/mint/art_x');
    expect(routePath({ name: 'collection', page: 1, perPage: null, item: 9 })).toBe('#/collection/9');
    expect(routePath({ name: 'collection', page: 2, perPage: 40, item: null })).toBe('#/collection?page=2&per=40');
  });

  it('the mint wizard lives at #/mint[/:id]; #/ is the Home page since the site rebuild', () => {
    expect(isMintRoute(parseRoute('#/'))).toBe(false);
    expect(isMintRoute(parseRoute('#/mint'))).toBe(true);
    expect(isMintRoute(parseRoute('#/mint/art_1'))).toBe(true);
    expect(isMintRoute(parseRoute('#/gallery'))).toBe(false);
    expect(isMintRoute(parseRoute('#/studio'))).toBe(false);
  });
});

describe('hash router: useRoute', () => {
  it('navigate(…, { replace: true }) swaps the history entry instead of adding one', () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate('#/collection/3'));
    const depth = window.history.length;
    act(() => navigate({ name: 'collection', page: 1, perPage: null, item: 4 }, { replace: true }));
    expect(result.current).toEqual({ name: 'collection', page: 1, perPage: null, item: 4 });
    expect(window.location.hash).toBe('#/collection/4');
    expect(window.history.length).toBe(depth);
  });

  it('follows navigate() and the browser hashchange event', () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'home' });
    act(() => navigate('#/gallery'));
    expect(result.current).toEqual({ name: 'gallery', page: 1, artist: null });
    expect(window.location.hash).toBe('#/gallery');
    act(() => navigate({ name: 'artwork', id: 'art_9' }));
    expect(result.current).toEqual({ name: 'artwork', id: 'art_9' });
    act(() => {
      window.location.hash = '#/studio';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current).toEqual({ name: 'studio' });
  });
});
