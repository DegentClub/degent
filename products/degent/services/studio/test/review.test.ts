/** Reviewers: rules on real headers, the composite's never-approve-on-skip rule, and the Claude vision adapter with a fake client. */
import { describe, expect, it } from 'vitest';
import { DEGENT_PLACARD_WORDS, DEGENT_RULES } from '@bsh/degent-mint-sdk';
import { ClaudeVisionReview, MAX_IMAGE_BYTES, VISION_REVIEW_MODEL, type BetaMessagesCreate, type Downscaler } from '../src/adapters/claude-vision-review.js';
import { CompositeArtReview, HumanGateReview, RulesArtReview } from '../src/adapters/rules-art-review.js';
import { DEGENT_GUIDELINES } from '../src/domain/guidelines.js';
import { avif, gif, jpeg, png, squareArt } from './fakes/images.js';
import { FakeVisionReview, approve, needsHuman, reject } from './fakes/misc.js';

const rules = new RulesArtReview();
const input = (bytes: Uint8Array, declaredContentType = 'image/jpeg') => ({ artworkId: 'a', declaredContentType, bytes });

describe('RulesArtReview (real image headers, Degent rules)', () => {
  it.each([
    ['image/jpeg', jpeg(1024, 1024, 250_000)],
    ['image/png', png(256, 256, 200_000)],
    ['image/png', png(4096, 4096, 3_900_000)],
    ['image/gif', gif(512, 512, 500_000)],
    ['image/avif', avif(1000, 1000, 1_000_000)],
  ])('approves a square, in-bounds, in-tier %s', async (type, bytes) => {
    const r = await rules.review(input(bytes, type));
    expect(r.reasons).toEqual([]);
    expect(r).toMatchObject({ approved: true, needsHuman: false });
    expect(r.checks.map((c) => c.id)).toEqual(['magic_bytes', 'dimensions_readable', 'content_type', 'size', 'width', 'height', 'square']);
  });

  it('rejects non-square images (the square rule is on)', async () => {
    const r = await rules.review(input(jpeg(1024, 1000, 250_000)));
    expect(r.approved).toBe(false);
    expect(r.checks.find((c) => c.id === 'square')).toMatchObject({ passed: false, detail: 'not square (1024x1000px); width must equal height' });
  });

  it('rejects a type mismatch, unreadable dimensions, out-of-bounds dimensions and out-of-tier sizes', async () => {
    expect((await rules.review(input(png(512, 512, 250_000), 'image/jpeg'))).checks.find((c) => c.id === 'magic_bytes')?.passed).toBe(false);
    const noDims = new Uint8Array(250_000);
    noDims.set([0xff, 0xd8, 0xff, 0xd9]);
    expect((await rules.review(input(noDims))).checks.find((c) => c.id === 'dimensions_readable')?.passed).toBe(false);
    expect((await rules.review(input(jpeg(255, 255, 250_000)))).checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['width', 'height']);
    expect((await rules.review(input(jpeg(4097, 4097, 250_000)))).checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['width', 'height']);
    expect((await rules.review(input(jpeg(1024, 1024, 199_999)))).checks.find((c) => c.id === 'size')?.passed).toBe(false);
    expect((await rules.review(input(jpeg(1024, 1024, 3_900_001)))).checks.find((c) => c.id === 'size')?.passed).toBe(false);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(250_000, ' '));
    expect((await rules.review(input(svg, 'image/svg+xml'))).approved).toBe(false);
  });

  it('never asks for a human', async () => {
    expect((await rules.review(input(jpeg(10, 10)))).needsHuman).toBe(false);
  });
});

describe('CompositeArtReview', () => {
  it('namespaces checks and short-circuits on a rules rejection (no vision call)', async () => {
    const vision = new FakeVisionReview();
    const c = new CompositeArtReview([rules, vision]);
    const bad = await c.review(input(jpeg(10, 10, 250_000)));
    expect(bad).toMatchObject({ approved: false, needsHuman: false });
    expect(vision.calls).toHaveLength(0);
    expect(bad.checks.every((x) => x.id.startsWith('rules.'))).toBe(true);
    const good = await c.review(input(squareArt()));
    expect(good).toMatchObject({ approved: true, needsHuman: false, reasons: [] });
    expect(vision.calls).toHaveLength(1);
    expect(good.checks[good.checks.length - 1]!.id).toBe('vision.guidelines');
    expect(c.name).toBe('rules+vision');
  });

  it('never approves when any reviewer skipped: needsHuman wins over approvals', async () => {
    const c = new CompositeArtReview([rules, new FakeVisionReview(needsHuman())]);
    const r = await c.review(input(squareArt()));
    expect(r).toMatchObject({ approved: false, needsHuman: true, reasons: [] });
    expect(r.checks.find((x) => x.id === 'vision.guidelines')?.passed).toBe(false);
  });

  it('a rejection after a skip still rejects (no human needed to say no)', async () => {
    const c = new CompositeArtReview([new FakeVisionReview(needsHuman()), new FakeVisionReview(reject('nope'))]);
    const r = await c.review(input(squareArt()));
    expect(r).toMatchObject({ approved: false, needsHuman: false, reasons: ['nope'] });
  });

  it('a skip after an approval still needs a human', async () => {
    const c = new CompositeArtReview([new FakeVisionReview(approve()), new FakeVisionReview(needsHuman())]);
    expect(await c.review(input(squareArt()))).toMatchObject({ approved: false, needsHuman: true });
  });

  it('HumanGateReview stands in when no vision model is configured', async () => {
    const c = new CompositeArtReview([rules, new HumanGateReview()]);
    const r = await c.review(input(squareArt()));
    expect(r).toMatchObject({ approved: false, needsHuman: true });
    expect(r.checks.find((x) => x.id === 'vision.guidelines')?.detail).toContain('not configured');
  });
});

describe('DEGENT_GUIDELINES', () => {
  it('spell out the design rules, the placard words and the moderation list', () => {
    for (const word of ['Pepe', 'tuxedo', 'bow tie', 'frame', 'placard']) expect(DEGENT_GUIDELINES).toContain(word);
    expect(DEGENT_GUIDELINES).toContain(DEGENT_PLACARD_WORDS.join(', '));
    for (const r of DEGENT_RULES) expect(DEGENT_GUIDELINES).toContain(r.text);
    for (const m of ['minors', 'gore', 'hate symbols', 'seed phrases', 'QR codes', 'pure-noise']) expect(DEGENT_GUIDELINES).toContain(m);
    expect(DEGENT_GUIDELINES).toContain('approved: true only when every design rule');
  });
});

describe('ClaudeVisionReview (fake client only)', () => {
  const reply = (text: string, stop_reason = 'end_turn') =>
    (async () => ({ model: VISION_REVIEW_MODEL, stop_reason, content: [{ type: 'text', text }] })) as unknown as BetaMessagesCreate;

  it('is disabled without an API key', () => {
    expect(ClaudeVisionReview.fromEnv(undefined)).toBeNull();
    expect(ClaudeVisionReview.fromEnv(null)).toBeNull();
    expect(ClaudeVisionReview.fromEnv('')).toBeNull();
    expect(() => new ClaudeVisionReview({})).toThrow(/apiKey/);
    expect(ClaudeVisionReview.fromEnv('sk-test')).toBeInstanceOf(ClaudeVisionReview);
  });

  it('sends the image with structured output + adaptive thinking on claude-opus-5, exactly like the mint', async () => {
    let params: Parameters<BetaMessagesCreate>[0] | undefined;
    const create: BetaMessagesCreate = async (p) => {
      params = p;
      return reply('{"approved":true,"reasons":[]}')(p);
    };
    const v = new ClaudeVisionReview({ create });
    const bytes = squareArt(210_000);
    const r = await v.review(input(bytes));
    expect(r).toMatchObject({ approved: true, needsHuman: false, reasons: [] });
    expect(r.checks[0]).toMatchObject({ id: 'guidelines', passed: true, detail: `approved by ${VISION_REVIEW_MODEL}` });
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema' } },
      system: DEGENT_GUIDELINES,
    });
    const content = (params!.messages[0]!.content as Array<{ type: string; source?: { media_type: string; data: string } }>);
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
    expect(Buffer.from(content[0]!.source!.data, 'base64').equals(Buffer.from(bytes))).toBe(true);
    expect(content[1]).toMatchObject({ type: 'text' });
    expect((params!.output_config as unknown as { format: { schema: { required: string[] } } }).format.schema.required).toEqual(['approved', 'reasons']);
  });

  it('custom guidelines replace the default system prompt', async () => {
    let system: unknown;
    const v = new ClaudeVisionReview({ create: async (p) => ((system = p.system), reply('{"approved":true,"reasons":[]}')(p)), guidelines: 'be nice' });
    await v.review(input(squareArt()));
    expect(system).toBe('be nice');
  });

  it('maps a rejecting verdict to reasons (capped at 10) and a failed check', async () => {
    const reasons = Array.from({ length: 12 }, (_, i) => `rule ${i}`);
    const v = new ClaudeVisionReview({ create: reply(JSON.stringify({ approved: false, reasons })) });
    const r = await v.review(input(squareArt()));
    expect(r).toMatchObject({ approved: false, needsHuman: false });
    expect(r.reasons).toHaveLength(10);
    expect(r.checks[0]).toMatchObject({ id: 'guidelines', passed: false });
    expect(r.checks[0]!.detail).toContain('rule 0');
  });

  it('treats a refusal stop reason as a rejection, not as needing a human', async () => {
    const v = new ClaudeVisionReview({ create: reply('', 'refusal') });
    const r = await v.review(input(squareArt()));
    expect(r).toMatchObject({ approved: false, needsHuman: false, reasons: ['automated review declined this image'] });
  });

  it('throws on an unparseable verdict (the API maps it to 503, the artwork stays submitted)', async () => {
    const v = new ClaudeVisionReview({ create: reply('not json') });
    await expect(v.review(input(squareArt()))).rejects.toThrow(/unparseable/);
    const v2 = new ClaudeVisionReview({ create: reply('{"approved":"yes","reasons":[]}') });
    await expect(v2.review(input(squareArt()))).rejects.toThrow(/unparseable/);
  });

  it('propagates transport errors', async () => {
    const v = new ClaudeVisionReview({ create: async () => Promise.reject(new Error('ECONNRESET')) });
    await expect(v.review(input(squareArt()))).rejects.toThrow('ECONNRESET');
  });

  it('skips unsupported types (AVIF) as needsHuman, never approving, without calling the API', async () => {
    let calls = 0;
    const v = new ClaudeVisionReview({ create: async (p) => (calls++, reply('{"approved":true,"reasons":[]}')(p)) });
    const r = await v.review(input(avif(1000, 1000, 250_000), 'image/avif'));
    expect(r).toMatchObject({ approved: false, needsHuman: true, reasons: [] });
    expect(r.checks[0]!.detail).toContain('image/avif is not supported');
    expect(r.checks[0]!.detail).toContain('house reviewer');
    expect(calls).toBe(0);
  });

  it('skips oversized images (> 3.7 MB) as needsHuman when no downscaler is wired', async () => {
    let calls = 0;
    const v = new ClaudeVisionReview({ create: async (p) => (calls++, reply('{"approved":true,"reasons":[]}')(p)) });
    expect(MAX_IMAGE_BYTES).toBe(3_700_000);
    const r = await v.review(input(jpeg(2048, 2048, MAX_IMAGE_BYTES + 1)));
    expect(r).toMatchObject({ approved: false, needsHuman: true });
    expect(r.checks[0]!.detail).toContain('exceeds the model image limit');
    expect(calls).toBe(0);
    expect((await v.review(input(jpeg(2048, 2048, MAX_IMAGE_BYTES)))).approved).toBe(true);
    expect(calls).toBe(1);
  });

  it('uses the injected downscaler for oversized JPEGs and sends the smaller copy', async () => {
    let sent: string | undefined;
    const small = squareArt(300_000);
    const downscale: Downscaler = async ({ bytes, contentType, maxBytes }) => {
      expect(bytes.length).toBeGreaterThan(maxBytes);
      expect(contentType).toBe('image/jpeg');
      return { bytes: small, contentType: 'image/jpeg' };
    };
    const v = new ClaudeVisionReview({
      create: async (p) => {
        sent = (p.messages[0]!.content as Array<{ source: { data: string } }>)[0]!.source.data;
        return reply('{"approved":true,"reasons":[]}')(p);
      },
      downscale,
    });
    const r = await v.review(input(jpeg(4096, 4096, 3_800_000)));
    expect(r.approved).toBe(true);
    expect(Buffer.from(sent!, 'base64').equals(Buffer.from(small))).toBe(true);
  });

  it('a downscaler that fails or stays too big still yields needsHuman; PNGs are never downscaled', async () => {
    let calls = 0;
    const create: BetaMessagesCreate = async (p) => (calls++, reply('{"approved":true,"reasons":[]}')(p));
    const failing = new ClaudeVisionReview({ create, downscale: async () => null });
    expect((await failing.review(input(jpeg(4096, 4096, 3_800_000)))).needsHuman).toBe(true);
    const tooBig = new ClaudeVisionReview({ create, downscale: async () => ({ bytes: jpeg(4096, 4096, 3_750_000), contentType: 'image/jpeg' }) });
    expect((await tooBig.review(input(jpeg(4096, 4096, 3_800_000)))).needsHuman).toBe(true);
    let downscaleCalls = 0;
    const pngOnly = new ClaudeVisionReview({ create, downscale: async () => (downscaleCalls++, { bytes: squareArt(), contentType: 'image/jpeg' }) });
    expect((await pngOnly.review(input(png(4096, 4096, 3_800_000), 'image/png'))).needsHuman).toBe(true);
    expect(downscaleCalls).toBe(0);
    expect(calls).toBe(0);
  });
});
