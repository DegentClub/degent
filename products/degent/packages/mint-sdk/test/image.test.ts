import { describe, expect, it } from 'vitest';
import { readImageInfo, sniffContentType } from '../src/index.js';
import { avif, gif, jpeg, png, webpVp8, webpVp8l, webpVp8x } from './images.js';

describe('readImageInfo', () => {
  it.each([
    ['png', png(1024, 768), 'image/png', 1024, 768],
    ['png padded', png(300, 400, 250_000), 'image/png', 300, 400],
    ['jpeg', jpeg(2000, 1500), 'image/jpeg', 2000, 1500],
    ['jpeg padded (COM segments before SOF)', jpeg(512, 256, 250_000), 'image/jpeg', 512, 256],
    ['webp VP8X', webpVp8x(4096, 4096), 'image/webp', 4096, 4096],
    ['webp VP8L', webpVp8l(1000, 3000), 'image/webp', 1000, 3000],
    ['webp VP8', webpVp8(640, 480), 'image/webp', 640, 480],
    ['gif', gif(256, 300), 'image/gif', 256, 300],
    ['avif', avif(1200, 800), 'image/avif', 1200, 800],
  ])('%s', (_n, bytes, type, w, h) => {
    expect(readImageInfo(bytes)).toEqual({ contentType: type, width: w, height: h });
  });

  it('padded fixtures have the exact requested size', () => {
    expect(png(300, 300, 250_000).length).toBe(250_000);
    expect(jpeg(300, 300, 250_000).length).toBe(250_000);
  });

  it('returns null for unknown bytes and never throws on truncation', () => {
    expect(readImageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageInfo(new Uint8Array())).toBeNull();
    const full = png(500, 500);
    for (let n = 0; n < full.length; n++) expect(() => readImageInfo(full.slice(0, n))).not.toThrow();
    const j = jpeg(500, 500);
    for (let n = 0; n < j.length; n++) expect(() => readImageInfo(j.slice(0, n))).not.toThrow();
  });

  it('truncated headers yield unknown dimensions, not garbage', () => {
    expect(readImageInfo(png(500, 500).slice(0, 10))).toEqual({ contentType: 'image/png', width: null, height: null });
  });

  it('sniffs by magic bytes, not by declared type', () => {
    expect(sniffContentType(gif(300, 300))).toBe('image/gif');
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
});
