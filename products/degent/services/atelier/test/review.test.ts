import { describe, expect, it } from 'vitest';
import { CompositeArtReview, RulesArtReview, reviewRules, type ArtReview } from '../src/review.js';
import { readImageInfo } from '../src/image-info.js';
import { jpeg, png } from './fakes/images.js';

describe('rules review (re-implemented light checks)', () => {
  it('approves a square JPEG inside a tier and reports every check', () => {
    const r = reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 300_000), tier: 'standard' });
    expect(r.approved).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['magic_bytes', 'dimensions_readable', 'square', 'width', 'height', 'size', 'tier']);
  });

  it('rejects wrong magic bytes, non-square, out-of-bounds dimensions, bad size and tier mismatch', () => {
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: png(1024, 1024, 300_000) }).reasons).toContain('bytes are image/png but image/jpeg was declared');
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1000, 300_000) }).reasons).toContain('not square (1024x1000)');
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(8000, 8000, 300_000) }).approved).toBe(false);
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 150_000) }).reasons[0]).toMatch(/outside 200000-3900000/);
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 500_000), tier: 'standard' }).reasons[0]).toMatch(/does not match the standard tier \(got large\)/);
    expect(reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: new Uint8Array(300_000) }).reasons[0]).toMatch(/not a recognised image/);
  });

  it('tier boundaries are inclusive and exact', () => {
    const at = (n: number) => reviewRules({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(512, 512, n) });
    expect(at(199_999).approved).toBe(false);
    expect(at(200_000).approved).toBe(true);
    expect(at(400_000).checks.find((c) => c.id === 'size')!.detail).toMatch(/Standard/);
    expect(at(400_001).checks.find((c) => c.id === 'size')!.detail).toMatch(/Large/);
    expect(at(3_499_999).checks.find((c) => c.id === 'size')!.detail).toMatch(/Large/);
    expect(at(3_500_000).checks.find((c) => c.id === 'size')!.detail).toMatch(/Full Block/);
    expect(at(3_900_000).approved).toBe(true);
    expect(at(3_900_001).approved).toBe(false);
  });

  it('composite stops at the first rejection and namespaces checks', async () => {
    let visionCalls = 0;
    const vision: ArtReview = { name: 'vision', review: async () => (visionCalls++, { approved: true, reasons: [], checks: [{ id: 'guidelines', passed: true, detail: 'ok' }] }) };
    const c = new CompositeArtReview([new RulesArtReview(), vision]);
    const bad = await c.review({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(10, 20, 300_000) });
    expect(bad.approved).toBe(false);
    expect(visionCalls).toBe(0);
    const good = await c.review({ refId: 'x', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 300_000) });
    expect(good.approved).toBe(true);
    expect(good.checks.map((x) => x.id)).toContain('vision.guidelines');
    expect(good.checks.map((x) => x.id)).toContain('rules.square');
  });

  it('header sniffing reads png / jpeg / webp / gif dimensions', () => {
    expect(readImageInfo(png(300, 200))).toEqual({ contentType: 'image/png', width: 300, height: 200 });
    expect(readImageInfo(jpeg(640, 480))).toEqual({ contentType: 'image/jpeg', width: 640, height: 480 });
    const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0x10, 0, 0x20, 0, 0, 0, 0, 0]);
    expect(readImageInfo(gif)).toEqual({ contentType: 'image/gif', width: 16, height: 32 });
    expect(readImageInfo(new Uint8Array(4))).toBeNull();
  });
});
