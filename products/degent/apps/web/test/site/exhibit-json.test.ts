/**
 * Full Block Exhibit: the maths and the machine-native JSON twin/index shapes.
 *
 * The one-block visualization's scale is asserted numerically (fill fraction === weight / 4,000,000
 * within rounding). The index and per-item JSON are validated against the JSON Schemas in
 * `schemas/` with a small draft-07 subset validator (no new dependency).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS, estimateRevealWeight, vsizeFromWeight } from '@bsh/inscription';
import { FULLBLOCK_MIN_BYTES } from '@bsh/degent-mint-sdk';
import {
  BLOCK_WEIGHT_LIMIT,
  blockFraction,
  contentBytesOf,
  estimateReveal,
  estimateWeightForContent,
  exhibitIndexJson,
  exhibitItemJson,
  fullBlockItems,
  isFullBlock,
  revealTxidOf,
  type LinkBases,
} from '../../src/site/lib/exhibit';
import type { CollectionItem } from '../../src/site/services/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '../../schemas');
const BASES: LinkBases = { ordinals: 'https://ordinals.com', magicEden: 'https://magiceden.io', blockspace: 'https://block.space' };

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));
}

// --- a tiny draft-07 subset validator (type/const/enum/required/properties/additionalProperties/items/$ref/min/max/pattern)
function validate(schema: Record<string, unknown>, data: unknown, refs: Record<string, Record<string, unknown>>, path = '$'): string[] {
  const errs: string[] = [];
  if (typeof schema.$ref === 'string') {
    const ref = refs[schema.$ref];
    if (!ref) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(ref, data, refs, path);
  }
  if ('const' in schema && data !== schema.const) errs.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(data as never)) errs.push(`${path}: ${JSON.stringify(data)} not in enum`);
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types) {
    const ok = types.some((t) => {
      if (t === 'null') return data === null;
      if (t === 'integer') return typeof data === 'number' && Number.isInteger(data);
      if (t === 'number') return typeof data === 'number';
      if (t === 'array') return Array.isArray(data);
      if (t === 'object') return typeof data === 'object' && data !== null && !Array.isArray(data);
      return typeof data === t;
    });
    if (!ok) errs.push(`${path}: expected type ${types.join('|')}, got ${data === null ? 'null' : typeof data}`);
  }
  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) errs.push(`${path}: ${data} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && data > schema.maximum) errs.push(`${path}: ${data} > maximum ${schema.maximum}`);
  }
  if (typeof data === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data)) errs.push(`${path}: ${data} does not match ${schema.pattern}`);
  if (Array.isArray(data) && schema.items) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    data.forEach((el, i) => errs.push(...validate(schema.items as Record<string, unknown>, el, refs, `${path}[${i}]`)));
  }
  if (typeof data === 'object' && data !== null && !Array.isArray(data) && schema.type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in data)) errs.push(`${path}: missing required "${key}"`);
    for (const [key, val] of Object.entries(data)) {
      if (props[key]) errs.push(...validate(props[key], val, refs, `${path}.${key}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: additional property "${key}"`);
    }
  }
  return errs;
}

const itemSchema = loadSchema('exhibit-item.schema.json');
const indexSchema = loadSchema('exhibit-index.schema.json');
const REFS = { 'exhibit-item.schema.json': itemSchema };

function item(number: number, sizeKb: number): CollectionItem {
  const hex = (number.toString(16).padStart(2, '0')).repeat(32).slice(0, 64);
  return { id: `${hex}i0`, number, name: `Degent #${number}`, size_kb: sizeKb };
}

describe('exhibit maths reuse the SDK', () => {
  it('block weight limit is the consensus 4,000,000 WU from @bsh/inscription', () => {
    expect(BLOCK_WEIGHT_LIMIT).toBe(4_000_000);
    expect(BLOCK_WEIGHT_LIMIT).toBe(LIMITS.MAX_BLOCK_WEIGHT);
  });

  it('estimated reveal weight equals estimateRevealWeight for the same content length', () => {
    const p2tr = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32));
    for (const bytes of [FULLBLOCK_MIN_BYTES, 3_700_000, 3_900_000, 3_962_660]) {
      const direct = estimateRevealWeight({ content: { contentType: 'image/jpeg', body: new Uint8Array(bytes) }, withParent: false, recipientScript: p2tr });
      expect(estimateWeightForContent(bytes)).toBe(direct);
      const est = estimateReveal(bytes);
      expect(est.weight).toBe(direct);
      expect(est.vsize).toBe(vsizeFromWeight(direct));
      expect(est.lane).toBe('block');
    }
  });

  it('the one-block fraction is exactly weight / 4,000,000 (the viz scale)', () => {
    for (const bytes of [FULLBLOCK_MIN_BYTES, 3_800_000, 3_962_660]) {
      const est = estimateReveal(bytes);
      expect(est.fraction).toBeCloseTo(est.weight / BLOCK_WEIGHT_LIMIT, 10);
      expect(blockFraction(est.weight)).toBe(est.fraction);
      // a Full Block Degent fills a lot of the block, but never overflows it
      expect(est.fraction).toBeGreaterThan(0.85);
      expect(est.fraction).toBeLessThanOrEqual(1);
    }
  });

  it('classifies full-block by the SDK tier floor, not tierForSize (keeps items above 3.9 MB)', () => {
    expect(isFullBlock({ size_kb: 3499 })).toBe(false);
    expect(isFullBlock({ size_kb: 3500 })).toBe(true);
    expect(isFullBlock({ size_kb: 3962.66 })).toBe(true); // above the 3.9 MB mint cap, still a block-filler
    expect(contentBytesOf({ size_kb: 3500 })).toBe(3_500_000);
    expect(contentBytesOf({})).toBeNull();
  });

  it('sorts full-block items largest first', () => {
    const items = [item(1, 3600), item(2, 3900), item(3, 3500), item(4, 300)];
    const full = fullBlockItems(items);
    expect(full.map((x) => x.number)).toEqual([2, 1, 3]);
  });

  it('derives the reveal txid from the inscription id (index 0)', () => {
    expect(revealTxidOf(`${'a'.repeat(64)}i0`)).toBe('a'.repeat(64));
    expect(revealTxidOf('not-an-id')).toBeNull();
  });
});

describe('machine-native JSON twin + index match their schemas', () => {
  const items = [item(2770, 3962.66), item(2650, 3800), item(10, 250)];
  const index = exhibitIndexJson({ source: 'bundled', items }, BASES);

  it('index validates against exhibit-index.schema.json', () => {
    expect(validate(indexSchema, index, REFS)).toEqual([]);
    expect(index.count).toBe(2);
    expect(index.source).toBe('bundled');
    expect(index.certified).toBe(false);
    expect(index.items[0]!.number).toBe(2770); // largest first
  });

  it('a certified list is labelled certified:true', () => {
    const cert = exhibitIndexJson({ source: 'certified', items }, BASES);
    expect(cert.certified).toBe(true);
    expect(validate(indexSchema, cert, REFS)).toEqual([]);
  });

  it('per-item twin validates and carries the block.space X-Ray link on the reveal txid', () => {
    const twin = exhibitItemJson(items[0]!, BASES, { timestamp: '2024-02-01T00:00:00.000Z', height: 831000, feeSats: 1_500_000, address: 'bc1pexample', contentType: 'image/jpeg' });
    expect(validate(itemSchema, twin, REFS)).toEqual([]);
    expect(twin.tier).toBe('fullblock');
    expect(twin.lane).toBe('block');
    expect(twin.estimated).toBe(true);
    expect(twin.blockWeightLimitWU).toBe(4_000_000);
    expect(twin.links.xray).toBe(`https://block.space/xray/${revealTxidOf(items[0]!.id)}`);
    expect(twin.links.theater).toBe('https://block.space/theater?block=831000');
    // fee rate = fee / estimated vsize
    expect(twin.feeRate).toBeCloseTo(1_500_000 / twin.revealVsize, 6);
  });

  it('theater link is null until a block height is known (honest)', () => {
    const twin = exhibitItemJson(items[0]!, BASES);
    expect(twin.links.theater).toBeNull();
    expect(twin.feeRate).toBeNull();
    expect(twin.facts.height).toBeNull();
  });

  it('block.space base is configurable', () => {
    const twin = exhibitItemJson(items[0]!, { ...BASES, blockspace: 'https://staging.blockspace.example' }, { ...{ timestamp: null, feeSats: null, address: null, contentType: null }, height: 900000 });
    expect(twin.links.xray!.startsWith('https://staging.blockspace.example/xray/')).toBe(true);
    expect(twin.links.theater).toBe('https://staging.blockspace.example/theater?block=900000');
  });
});
