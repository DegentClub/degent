import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, MINTING_RULES } from '@bsh/degent-mint-sdk';
import { ART_REVIEW_MODEL, ClaudeArtReview, DEFAULT_GUIDELINES, VERDICT_SCHEMA, parseVisionVerdict, type BetaMessagesCreate } from '../src/adapters/claude-art-review.js';
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

describe('advisory minting rules in the deterministic review', () => {
  it('fills square exactly from the dimensions and leaves the rest unknown', async () => {
    const sq = await rules.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(1024, 1024, 200_000) });
    expect(sq.rules).toMatchObject({ square: 'pass', pepeInTuxWithBowtie: 'unknown', framedWithPlacard: 'unknown', placardText: null });
    expect(sq.rules!.notes.square).toBe('1024x1024px is square');
    const wide = await rules.review({ orderId: 'o', declaredContentType: 'image/jpeg', bytes: jpeg(2048, 1024, 250_000) });
    expect(wide.rules!.square).toBe('fail');
    // advisory: a non-square image is still approved
    expect(wide.approved).toBe(true);
    const noDims = await rules.review({ orderId: 'o', declaredContentType: 'image/jpeg', bytes: pad(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) });
    expect(noDims.rules!.square).toBe('unknown');
  });
});

const VISION_OK = {
  approved: true,
  reasons: [],
  rules: {
    pepeInTuxWithBowtie: { verdict: 'pass', note: 'Pepe in a tuxedo with a black bowtie' },
    framedWithPlacard: { verdict: 'fail', note: 'no frame around the artwork' },
    placardText: 'DEGENT',
  },
};

describe('ClaudeArtReview (optional vision adapter, fake client only)', () => {
  const reply = (text: string, stop_reason = 'end_turn', extra: Record<string, unknown> = {}) =>
    (async () => ({ model: ART_REVIEW_MODEL, stop_reason, content: [{ type: 'text', text }], ...extra })) as unknown as BetaMessagesCreate;
  const json = (v: unknown) => reply(JSON.stringify(v));
  const img = { orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300) };

  it('is disabled without an API key', () => {
    expect(ClaudeArtReview.fromEnv(undefined)).toBeNull();
    expect(ClaudeArtReview.fromEnv('')).toBeNull();
    expect(() => new ClaudeArtReview({})).toThrow(/apiKey/);
  });

  it('sends the image with structured output (the verdict schema), adaptive thinking and refusal fallbacks', async () => {
    let params: Parameters<BetaMessagesCreate>[0] | undefined;
    const create = (async (p: Parameters<BetaMessagesCreate>[0]) => {
      params = p;
      return { model: ART_REVIEW_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(VISION_OK) }] };
    }) as unknown as BetaMessagesCreate;
    const r = await new ClaudeArtReview({ create }).review(img);
    expect(r.approved).toBe(true);
    expect(params).toMatchObject({
      model: ART_REVIEW_MODEL,
      thinking: { type: 'adaptive' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    });
    const block = (params!.messages[0]!.content as Array<{ type: string; source?: { media_type: string } }>)[0]!;
    expect(block).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    // every nested object in the schema is closed, as structured outputs require
    const closed = (s: any): boolean =>
      s.type !== 'object' || (s.additionalProperties === false && Object.values(s.properties ?? {}).every(closed));
    expect(closed(VERDICT_SCHEMA)).toBe(true);
  });

  it('the default guidelines carry the four site rules verbatim and keep the six rejection categories', () => {
    for (const r of MINTING_RULES) expect(DEFAULT_GUIDELINES).toContain(`${r.title}: "${r.text}"`);
    for (const c of ['explicit sexual content', 'gore', 'hate symbols', 'seed phrases', 'QR codes', 'pure-noise image'])
      expect(DEFAULT_GUIDELINES).toContain(c);
    expect(DEFAULT_GUIDELINES).toMatch(/never a reason to set "approved" to false/);
  });

  it('maps the advisory rules onto the contract shape; a failed rule never rejects', async () => {
    const r = await new ClaudeArtReview({ create: json(VISION_OK) }).review(img);
    expect(r.approved).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.rules).toEqual({
      square: 'unknown',
      pepeInTuxWithBowtie: 'pass',
      framedWithPlacard: 'fail',
      placardText: 'DEGENT',
      notes: {
        square: 'measured from the image header by the rules review',
        pepeInTuxWithBowtie: 'Pepe in a tuxedo with a black bowtie',
        framedWithPlacard: 'no frame around the artwork',
      },
    });
    const none = await new ClaudeArtReview({ create: json({ ...VISION_OK, rules: { ...VISION_OK.rules, placardText: 'none' } }) }).review(img);
    expect(none.rules!.placardText).toBeNull();
    const long = 'x'.repeat(500);
    const clipped = await new ClaudeArtReview({
      create: json({ ...VISION_OK, rules: { ...VISION_OK.rules, framedWithPlacard: { verdict: 'unknown', note: long } } }),
    }).review(img);
    expect(clipped.rules!.notes.framedWithPlacard.length).toBeLessThanOrEqual(200);
  });

  it('validates the verdict against the schema (parseVisionVerdict)', () => {
    expect(parseVisionVerdict(JSON.stringify(VISION_OK))).toEqual(VISION_OK);
    const bad: Array<[string, unknown]> = [
      ['not json', 'nope'],
      ['missing rules', { approved: true, reasons: [] }],
      ['approved not boolean', { ...VISION_OK, approved: 'yes' }],
      ['reasons not strings', { ...VISION_OK, reasons: [1] }],
      ['extra top-level key', { ...VISION_OK, score: 3 }],
      ['bad verdict enum', { ...VISION_OK, rules: { ...VISION_OK.rules, pepeInTuxWithBowtie: { verdict: 'maybe', note: '' } } }],
      ['missing note', { ...VISION_OK, rules: { ...VISION_OK.rules, framedWithPlacard: { verdict: 'pass' } } }],
      ['bad placard', { ...VISION_OK, rules: { ...VISION_OK.rules, placardText: 'DEGENERATE' } }],
      ['square is not the model\'s to answer', { ...VISION_OK, rules: { ...VISION_OK.rules, square: { verdict: 'pass', note: '' } } }],
    ];
    for (const [why, v] of bad) expect(() => parseVisionVerdict(typeof v === 'string' ? v : JSON.stringify(v)), why).toThrow(/schema/);
  });

  it('an off-schema reply is a retryable error (throws), never a rejection', async () => {
    await expect(new ClaudeArtReview({ create: reply('not json') }).review(img)).rejects.toThrow(/unparseable/);
    await expect(new ClaudeArtReview({ create: json({ approved: false, reasons: ['x'] }) }).review(img)).rejects.toThrow(/unparseable/);
    await expect(new ClaudeArtReview({ create: reply('{"approved":', 'max_tokens') }).review(img)).rejects.toThrow(/max_tokens/);
  });

  it('maps a safety rejection to not-approved with its reasons', async () => {
    const rej = await new ClaudeArtReview({ create: json({ ...VISION_OK, approved: false, reasons: ['contains a QR code scam'] }) }).review(img);
    expect(rej).toMatchObject({ approved: false, reasons: ['contains a QR code scam'] });
    expect(rej.rules!.pepeInTuxWithBowtie).toBe('pass');
  });

  it('handles a final refusal: rejected, category kept in the check detail, rules unknown', async () => {
    const r = await new ClaudeArtReview({
      create: reply('', 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }),
    }).review(img);
    expect(r.approved).toBe(false);
    expect(r.reasons).toEqual(['automated review declined this image']);
    expect(r.checks[0]!.detail).toContain('(cyber)');
    expect(r.rules).toMatchObject({ square: 'unknown', pepeInTuxWithBowtie: 'unknown', framedWithPlacard: 'unknown', placardText: null });
    const noDetails = await new ClaudeArtReview({ create: reply('', 'refusal', { stop_details: null }) }).review(img);
    expect(noDetails.checks[0]!.detail).toBe('automated review declined this image');
  });

  it('skips unsupported types and oversized images without calling the model', async () => {
    let called = false;
    const create = (async () => {
      called = true;
      throw new Error('should not be called');
    }) as unknown as BetaMessagesCreate;
    const avifR = await new ClaudeArtReview({ create }).review({ orderId: 'o', declaredContentType: 'image/avif', bytes: avif(500, 500) });
    expect(avifR.approved).toBe(true);
    expect(avifR.rules!.pepeInTuxWithBowtie).toBe('unknown');
    expect(avifR.rules!.notes.framedWithPlacard).toMatch(/not supported/);
    const big = await new ClaudeArtReview({ create }).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300, 3_800_000) });
    expect(big.approved).toBe(true);
    expect(big.checks[0]!.detail).toMatch(/exceeds/);
    expect(called).toBe(false);
  });
});

describe('advisory rules merge across reviewers (rules + vision)', () => {
  it('square from the rules reviewer wins over the model; design/framing/placard come from the model', async () => {
    const vision = new ClaudeArtReview({ create: visionReply({ ...VISION_OK }) });
    const c = new CompositeArtReview([rules, vision]);
    const r = await c.review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(800, 600, 200_000) });
    expect(r.approved).toBe(true);
    expect(r.rules).toMatchObject({ square: 'fail', pepeInTuxWithBowtie: 'pass', framedWithPlacard: 'fail', placardText: 'DEGENT' });
    expect(r.rules!.notes.square).toBe('800x600px is not square');
    expect(r.checks.map((x) => x.id)).toContain('vision.guidelines');
  });

  it('a hard rules rejection short-circuits: only the rules advice is present', async () => {
    const vision = new FakeArtReview();
    const r = await new CompositeArtReview([rules, vision]).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(10, 10, 200_000) });
    expect(r.approved).toBe(false);
    expect(vision.calls).toHaveLength(0);
    expect(r.rules).toMatchObject({ square: 'pass', pepeInTuxWithBowtie: 'unknown' });
  });

  it('reviewers without advice leave rules absent', async () => {
    const r = await new CompositeArtReview([new FakeArtReview()]).review({ orderId: 'o', declaredContentType: 'image/png', bytes: png(300, 300) });
    expect(r.rules).toBeUndefined();
  });
});

function visionReply(v: unknown): BetaMessagesCreate {
  return (async () => ({ model: ART_REVIEW_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }] })) as unknown as BetaMessagesCreate;
}
