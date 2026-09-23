import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@bsh/degent-mint-sdk';
import { ClaudeArtReview, type BetaMessagesCreate } from '../src/adapters/claude-art-review.js';
import { CompositeArtReview, RulesArtReview } from '../src/adapters/rules-art-review.js';
import { avif, gif, jpeg, png, webpVp8l, webpVp8x } from './fakes/images.js';
import { FakeArtReview } from './fakes/misc.js';

const rules = new RulesArtReview(DEFAULT_CONFIG);
const pad = (header: Uint8Array, size = 200_000) => {
  const out = new Uint8Array(size);
  out.set(header);
  return out;
};

describe('RulesArtReview (real image headers)', () => {
  it.each([
    ['image/png', png(1024, 1024, 200_000)],
    ['image/jpeg', jpeg(2048, 1024, 250_000)],
    ['image/webp', pad(webpVp8x(4096, 256))],
    ['image/webp', pad(webpVp8l(300, 300))],
    ['image/gif', pad(gif(512, 512), 500_000)],
    ['image/avif', pad(avif(1000, 1000))],
  ])('approves a valid %s', async (type, bytes) => {
    const r = await rules.review({ orderId: 'o', declaredContentType: type, bytes });
    expect(r.reasons).toEqual([]);
    expect(r.approved).toBe(true);
  });

  it('rejects a type mismatch (declared png, bytes are gif)', async () => {
    const r = await rules.review({ orderId: 'o', declaredContentType: 'image/png', bytes: pad(gif(512, 512)) });
    expect(r.approved).toBe(false);
    expect(r.checks.find((c) => c.id === 'magic_bytes')).toMatchObject({ passed: false, detail: expect.stringContaining('image/gif') });
  });

  it('rejects dimensions outside 256-4096', async () => {
    const small = await rules.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(255, 1000, 200_000) });
    expect(small.approved).toBe(false);
    expect(small.checks.find((c) => c.id === 'width')?.passed).toBe(false);
    const big = await rules.review({ orderId: 'o', declaredContentType: 'image/jpeg', bytes: jpeg(1000, 4097, 200_000) });
    expect(big.approved).toBe(false);
    expect(big.checks.find((c) => c.id === 'height')?.passed).toBe(false);
  });

  it('rejects non-images, unreadable dimensions and out-of-tier sizes', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(200_000, ' '));
    expect((await rules.review({ orderId: 'o', declaredContentType: 'image/svg+xml', bytes: svg })).approved).toBe(false);
    const noDims = pad(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const r = await rules.review({ orderId: 'o', declaredContentType: 'image/jpeg', bytes: noDims });
    expect(r.checks.find((c) => c.id === 'dimensions_readable')?.passed).toBe(false);
    const tiny = await rules.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(500, 500) });
    expect(tiny.checks.find((c) => c.id === 'size')?.passed).toBe(false);
  });
});

describe('CompositeArtReview', () => {
  it('namespaces checks and short-circuits on the first rejection', async () => {
    const second = new FakeArtReview();
    const c = new CompositeArtReview([rules, second]);
    const bad = await c.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(10, 10, 200_000) });
    expect(bad.approved).toBe(false);
    expect(second.calls).toHaveLength(0);
    expect(bad.checks.every((x) => x.id.startsWith('rules.'))).toBe(true);
    const good = await c.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300, 200_000) });
    expect(good.approved).toBe(true);
    expect(second.calls).toHaveLength(1);
  });
});

describe('ClaudeArtReview (optional vision adapter, fake client only)', () => {
  const reply = (text: string, stop_reason = 'end_turn') =>
    (async () => ({ model: 'claude-opus-5', stop_reason, content: [{ type: 'text', text }] })) as unknown as BetaMessagesCreate;

  it('is disabled without an API key', () => {
    expect(ClaudeArtReview.fromEnv(undefined)).toBeNull();
    expect(ClaudeArtReview.fromEnv('')).toBeNull();
    expect(() => new ClaudeArtReview({})).toThrow(/apiKey/);
  });

  it('sends the image with structured output + adaptive thinking on claude-opus-5', async () => {
    let params: Parameters<BetaMessagesCreate>[0] | undefined;
    const create = (async (p: Parameters<BetaMessagesCreate>[0]) => {
      params = p;
      return { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"approved":true,"reasons":[]}' }] };
    }) as unknown as BetaMessagesCreate;
    const r = await new ClaudeArtReview({ create }).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300) });
    expect(r.approved).toBe(true);
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema' } },
    });
    const img = (params!.messages[0]!.content as Array<{ type: string; source?: { media_type: string } }>)[0]!;
    expect(img).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
  });

  it('maps a rejection and a refusal to not-approved', async () => {
    const rej = await new ClaudeArtReview({ create: reply('{"approved":false,"reasons":["contains a QR code scam"]}') }).review({
      orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300),
    });
    expect(rej).toMatchObject({ approved: false, reasons: ['contains a QR code scam'] });
    const refusal = await new ClaudeArtReview({ create: reply('', 'refusal') }).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300) });
    expect(refusal.approved).toBe(false);
  });

  it('skips AVIF (unsupported by the model) without calling it; throws on garbage', async () => {
    let called = false;
    const create = (async () => {
      called = true;
      throw new Error('should not be called');
    }) as unknown as BetaMessagesCreate;
    const r = await new ClaudeArtReview({ create }).review({ orderId: 'o', declaredContentType: 'image/avif', bytes: avif(500, 500) });
    expect(r.approved).toBe(true);
    expect(called).toBe(false);
    await expect(new ClaudeArtReview({ create: reply('not json') }).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300) })).rejects.toThrow(/unparseable/);
  });
});
