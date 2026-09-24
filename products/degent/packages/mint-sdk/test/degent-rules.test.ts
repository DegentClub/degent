/**
 * Rules as code: the square check, format advice and the published Degent rules, cross-checked
 * against the machine-readable contract contracts/schemas/degent-rules.json.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEGENT_PLACARD_WORDS,
  DEGENT_RECOMMENDED_CONTENT_TYPE,
  DEGENT_RULES,
  DEGENT_RULES_CONFIG,
  DEGENT_RULES_VERSION,
  FULLBLOCK_MAX_BYTES,
  STANDARD_MIN_BYTES,
  formatAdvice,
  recommendedContentType,
  validateContentMeta,
} from '../src/index.js';

const schema = JSON.parse(readFileSync(new URL('../../../../../contracts/schemas/degent-rules.json', import.meta.url), 'utf8'));

describe('validateContentMeta square check', () => {
  const base = { contentType: 'image/jpeg', contentLength: 250_000 };

  it('is off by default (DEFAULT_CONFIG keeps the old check list)', () => {
    const r = validateContentMeta({ ...base, width: 1024, height: 512 });
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.id === 'square')).toBe(false);
  });

  it('adds a passing `square` check when width equals height', () => {
    const r = validateContentMeta({ ...base, width: 1024, height: 1024 }, DEGENT_RULES_CONFIG);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['content_type', 'size', 'width', 'height', 'square']);
    expect(r.checks.find((c) => c.id === 'square')).toEqual({ id: 'square', passed: true, detail: 'square (1024x1024px)' });
  });

  it('fails a non-square image with a user-facing reason', () => {
    const r = validateContentMeta({ ...base, width: 1024, height: 1023 }, DEGENT_RULES_CONFIG);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'square')?.passed).toBe(false);
    expect(r.reasons).toEqual(['not square (1024x1023px); width must equal height']);
  });

  it('only checks squareness when both dimensions are supplied', () => {
    expect(validateContentMeta({ ...base, width: 1024 }, DEGENT_RULES_CONFIG).checks.some((c) => c.id === 'square')).toBe(false);
    expect(validateContentMeta({ ...base }, DEGENT_RULES_CONFIG).checks.some((c) => c.id === 'square')).toBe(false);
  });

  it('a square image outside the dimension bounds fails width/height but passes square', () => {
    const r = validateContentMeta({ ...base, width: 5000, height: 5000 }, DEGENT_RULES_CONFIG);
    expect(r.checks.find((c) => c.id === 'square')?.passed).toBe(true);
    expect(r.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['width', 'height']);
  });

  it('DEGENT_RULES_CONFIG is DEFAULT_CONFIG plus requireSquare', () => {
    expect(DEGENT_RULES_CONFIG).toEqual({ ...DEFAULT_CONFIG, requireSquare: true });
    expect(DEFAULT_CONFIG.requireSquare).toBeUndefined();
  });
});

describe('formatAdvice', () => {
  it('recommends JPEG', () => {
    expect(recommendedContentType).toBe('image/jpeg');
    expect(DEGENT_RECOMMENDED_CONTENT_TYPE).toBe('image/jpeg');
    expect(formatAdvice('image/jpeg')).toEqual({ contentType: 'image/jpeg', level: 'recommended', advice: 'JPEG is the recommended format for a Degent.' });
    expect(formatAdvice('IMAGE/JPEG ').level).toBe('recommended');
  });

  it.each(['image/png', 'image/webp', 'image/avif', 'image/gif'])('accepts %s and still points at JPEG', (t) => {
    const a = formatAdvice(t);
    expect(a.level).toBe('accepted');
    expect(a.advice).toContain('image/jpeg');
    expect(a.advice).toContain(t);
  });

  it('refuses anything else and lists the alternatives', () => {
    const a = formatAdvice('image/svg+xml');
    expect(a.level).toBe('refused');
    expect(a.advice).toContain('image/jpeg (recommended)');
    expect(a.advice).toContain('image/png');
    expect(formatAdvice('').advice).toContain('(none)');
  });

  it('every allowed type is either recommended or accepted', () => {
    for (const t of DEFAULT_CONFIG.allowedContentTypes) expect(['recommended', 'accepted']).toContain(formatAdvice(t).level);
  });
});

describe('DEGENT_RULES (published rules as data)', () => {
  it('lists the five published rules with stable ids', () => {
    expect(DEGENT_RULES.map((r) => r.id)).toEqual(['format', 'square', 'design', 'framing', 'quantity']);
    expect(DEGENT_RULES_VERSION).toBe('1.0.0');
    for (const r of DEGENT_RULES) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(10);
      expect(['automated', 'vision', 'both']).toContain(r.check);
    }
  });

  it('keeps the site wording for the design and framing rules', () => {
    expect(DEGENT_RULES.find((r) => r.id === 'design')?.text).toBe('Pepe character wearing a tuxedo with a mandatory bowtie.');
    expect(DEGENT_RULES.find((r) => r.id === 'framing')?.text).toContain('"DEGEN", "DEGENT", or "REGEN"');
    expect(DEGENT_PLACARD_WORDS).toEqual(['DEGEN', 'DEGENT', 'REGEN']);
  });

  it('the size rule quotes the tier bounds', () => {
    const format = DEGENT_RULES.find((r) => r.id === 'format')!;
    expect(format.text).toContain(`${STANDARD_MIN_BYTES / 1000} KB`);
    expect(format.text).toContain(`${FULLBLOCK_MAX_BYTES / 1_000_000} MB`);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEGENT_RULES)).toBe(true);
    expect(Object.isFrozen(DEGENT_RULES_CONFIG)).toBe(true);
  });
});

describe('contracts/schemas/degent-rules.json agrees with the SDK', () => {
  it('is a 2020-12 schema versioned like the rules', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['x-rules-version']).toBe(DEGENT_RULES_VERSION);
  });

  it('content types and the recommendation match', () => {
    expect(schema.properties.contentType.enum).toEqual(DEFAULT_CONFIG.allowedContentTypes);
    expect(schema.properties.contentType['x-recommended']).toBe(recommendedContentType);
  });

  it('byte ranges are the tiers', () => {
    expect(schema.properties.bytes.oneOf).toEqual(
      DEFAULT_CONFIG.tiers.map((t) => ({ minimum: t.minBytes, maximum: t.maxBytes, 'x-tier': t.tier, 'x-label': t.label })),
    );
  });

  it('dimension bounds match', () => {
    for (const k of ['width', 'height']) {
      expect(schema.properties[k].minimum).toBe(DEFAULT_CONFIG.minDimensionPx);
      expect(schema.properties[k].maximum).toBe(DEFAULT_CONFIG.maxDimensionPx);
    }
  });

  it('vision rules and automated constraints partition the rule ids', () => {
    const vision = schema['x-vision'].map((v: { rule: string }) => v.rule);
    const constraints = schema['x-constraints'].map((v: { rule: string }) => v.rule);
    expect(vision).toEqual(DEGENT_RULES.filter((r) => r.check === 'vision' || r.check === 'both').map((r) => r.id));
    expect(constraints).toEqual(DEGENT_RULES.filter((r) => r.check === 'automated' && r.id !== 'format').map((r) => r.id));
    expect(schema['x-constraints'].find((c: { rule: string }) => c.rule === 'square').statement).toBe('width == height');
    for (const v of schema['x-vision']) expect(v.statement).toBe(DEGENT_RULES.find((r) => r.id === v.rule)!.text);
    expect(schema['x-vision'].find((v: { rule: string }) => v.rule === 'framing').placards).toEqual(DEGENT_PLACARD_WORDS);
  });
});
