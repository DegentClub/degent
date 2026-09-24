import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { compose, ComposeError, sha256Hex, type ComposeResult } from '../src/compose.js';
import { TIERS, type Tier } from '../src/domain/tiers.js';
import { readImageInfo } from '../src/image-info.js';
import { FakeImageProvider } from '../src/providers/fake.js';
import { reviewRules } from '../src/review.js';

let source: Uint8Array;
const results = new Map<Tier, ComposeResult>();

beforeAll(async () => {
  const [img] = await new FakeImageProvider().generate({ prompt: 'DJ at a rooftop party', size: '1024x1024', n: 1 });
  source = img!.bytes;
  expect(readImageInfo(source)).toEqual({ contentType: 'image/png', width: 1024, height: 1024 });
});

describe('compositor: every tier from a fake 1024x1024 source', () => {
  for (const t of TIERS) {
    it(`${t.tier}: square JPEG inside ${t.minBytes}-${t.maxBytes} bytes, sha256 of the exact bytes`, async () => {
      const r = await compose(source, { tier: t.tier, placard: 'DEGENT' });
      if (!r.ok) throw new Error(r.message);
      results.set(t.tier, r);
      expect(r.contentLength).toBe(r.bytes.length);
      expect(r.contentLength).toBeGreaterThanOrEqual(t.minBytes);
      expect(r.contentLength).toBeLessThanOrEqual(t.maxBytes);
      expect(r.contentType).toBe('image/jpeg');
      expect(r.sha256).toBe(sha256Hex(r.bytes));
      const info = readImageInfo(r.bytes)!;
      expect(info.contentType).toBe('image/jpeg');
      expect(info.width).toBe(info.height);
      expect(info.width).toBe(r.width);
      expect(r.width).toBeGreaterThanOrEqual(256);
      expect(r.width).toBeLessThanOrEqual(4096);
      // decodes cleanly with a real decoder too
      const meta = await sharp(Buffer.from(r.bytes)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', r.width, r.width]);
      // and passes the same rules review the upload path and the mint apply
      expect(reviewRules({ refId: 't', declaredContentType: 'image/jpeg', bytes: r.bytes, tier: t.tier }).approved).toBe(true);
    });
  }

  it('reports how each tier was reached (Full Block needs synthetic grain from a clean 1024px source)', () => {
    const std = results.get('standard')!;
    const fb = results.get('fullblock')!;
    expect(std.encoding.grain).toBe(0);
    // A clean 1024px source tops out near 2.2 MB even at 4096px q100, below the 3.5 MB Full Block floor.
    expect(fb.encoding.grain).toBeGreaterThan(0);
    expect(fb.width).toBeGreaterThan(1024);
  });

  it('is deterministic: identical inputs give identical bytes and sha256', async () => {
    const a = await compose(source, { tier: 'standard', placard: 'REGEN' });
    const b = await compose(Uint8Array.from(source), { tier: 'standard', placard: 'REGEN' });
    if (!a.ok || !b.ok) throw new Error('compose failed');
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    // a different placard is a different picture
    const c = await compose(source, { tier: 'standard', placard: 'DEGEN' });
    if (!c.ok) throw new Error('compose failed');
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('validates the placard option', async () => {
    await expect(compose(source, { tier: 'standard', placard: 'DEGENERATE' as never })).rejects.toBeInstanceOf(ComposeError);
    await expect(compose(source, { tier: 'standard' })).rejects.toThrow(/placard must be one of DEGEN, DEGENT, REGEN/);
    await expect(compose(source, { tier: 'standard', placard: 'degen' as never })).rejects.toThrow(/placard/);
  });

  it('frame=false still fits to a square and hits the range (non-square source is centre-cropped)', async () => {
    const wide = await sharp(Buffer.from(source)).resize(1600, 900, { fit: 'fill' }).png().toBuffer();
    const r = await compose(new Uint8Array(wide), { tier: 'standard', frame: false });
    if (!r.ok) throw new Error(r.message);
    expect(r.width).toBe(r.height);
    expect(r.placard).toBeNull();
    expect(r.contentLength).toBeGreaterThanOrEqual(200_000);
    expect(r.contentLength).toBeLessThanOrEqual(400_000);
  });

  it('reports range_unreachable instead of shipping non-compliant bytes', async () => {
    // Pure black without a frame: overlay grain cannot add entropy to black, so no canvas/quality reaches 200 KB.
    const black = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#000' } }).png().toBuffer();
    const r = await compose(new Uint8Array(black), { tier: 'standard', frame: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('range_unreachable');
    expect(r.message).toMatch(/200000 and 400000 bytes for the Standard Degent tier/);
  });

  it('refuses undecodable input', async () => {
    await expect(compose(new Uint8Array(1000).fill(7), { tier: 'standard', placard: 'DEGEN' })).rejects.toThrow();
  });
});
