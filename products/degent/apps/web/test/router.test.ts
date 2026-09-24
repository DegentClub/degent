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
    ];
    for (const r of routes) expect(parseRoute(routePath(r))).toEqual(r);
    expect(routePath({ name: 'gallery', page: 1, artist: null })).toBe('#/gallery');
    expect(routePath({ name: 'mint', artworkId: 'art_x' })).toBe('#/mint/art_x');
  });

  it('the mint wizard lives at #/ and #/mint[/:id]; nothing else', () => {
    expect(isMintRoute(parseRoute('#/'))).toBe(true);
    expect(isMintRoute(parseRoute('#/mint'))).toBe(true);
    expect(isMintRoute(parseRoute('#/mint/art_1'))).toBe(true);
    expect(isMintRoute(parseRoute('#/gallery'))).toBe(false);
    expect(isMintRoute(parseRoute('#/studio'))).toBe(false);
  });
});

describe('hash router: useRoute', () => {
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
