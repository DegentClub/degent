import { describe, it, expect } from 'vitest';
import { classifyContent, classifyContentDetailed, maxTier } from '../src/lib/content-classifier';

const TABLE = [
  // ---- manual: any financial framing ------------------------------------
  ['$12.8M at completion', 'manual'],
  ['floor value ~$52,800 current', 'manual'],
  ['the floor appreciates, as it should, fren.', 'manual'],
  ['price go up', 'manual'],
  ['existing blockspace reprices when fees rise', 'manual'],
  ['178x floor appreciation', 'manual'],
  ['this will 10x, trust me', 'manual'],
  ['a 2.5x from here is conservative', 'manual'],
  ['guaranteed returns, ser', 'manual'],
  ['guarantee: you will not regret this', 'manual'],
  ['best ROI on bitcoin', 'manual'],
  ['gentlemen invest in blockspace', 'manual'],
  ['an investment in permanence', 'manual'],
  ['~3.5-4 GB at completion', 'manual'],
  ['this is not financial advice', 'manual'],
  ['we are going to moon', 'manual'],
  ['$DGNT token launch soon', 'manual'],
  ['2000 dollars of blockspace', 'manual'],
  ['market cap says otherwise', 'manual'],
  ['take profits? gentlemen never sell.', 'manual'],

  // ---- review: numeric facts --------------------------------------------
  ['4,113 of 10,000 minted', 'review'],
  ['1.5 GB and counting', 'review'],
  ['written in the 0.13 sat/vB era', 'review'],
  ['500 gentlemen. the club grows.', 'auto'], // count without a fact-marker
  ['another 12 Degents minted while you slept', 'review'],
  ['we own 5-8% of all inscribed blockspace', 'review'],
  ['the largest collection on Bitcoin by blockspace. 1.5 GB. verify it with a node.', 'review'],
  ['gentlemen, a partnership.', 'review'],
  ['an announcement at dawn.', 'review'],

  // ---- auto: memes, gm, replies, banter ---------------------------------
  ['gm, gentlemen. the market awaits.', 'auto'],
  ['imagine explaining this to your grandchildren, ser.', 'auto'],
  ['welcome to the club, fren.', 'auto'],
  ['some collections trend. some collections endure.', 'auto'],
  ['blockspace is scarce. and you\'re early.', 'auto'], // blockspace word but no number
  ['a gentleman and a scholar.', 'auto'],
  ['', 'auto'],
];

describe('classifyContent', () => {
  it.each(TABLE)('%j -> %s', (text, expected) => {
    expect(classifyContent(text)).toBe(expected);
  });

  it('is case-insensitive for keywords', () => {
    expect(classifyContent('FLOOR IS UP')).toBe('manual');
    expect(classifyContent('Guaranteed')).toBe('manual');
  });

  it('does not treat "x" inside words as a multiplier', () => {
    expect(classifyContent('the xverse wallet works')).toBe('auto');
    expect(classifyContent('exactly')).toBe('auto');
  });

  it('does not confuse "returns to" with financial returns', () => {
    expect(classifyContent('the gentleman returns to the table')).toBe('auto');
  });

  it('reports the rules that fired', () => {
    const r = classifyContentDetailed('$12.8M at completion');
    expect(r.tier).toBe('manual');
    expect(r.reasons).toEqual(expect.arrayContaining(['dollar_amount', 'at_completion']));
  });

  it('marks replies as auto when otherwise clean', () => {
    const r = classifyContentDetailed('ser, those who know, know.', { contentType: 'reply' });
    expect(r.tier).toBe('auto');
    expect(r.reasons).toEqual(['reply']);
  });

  it('never lets contentType downgrade a manual classification', () => {
    expect(classifyContent('floor will 10x', { contentType: 'reply' })).toBe('manual');
    expect(classifyContent('floor will 10x', { contentType: 'meme' })).toBe('manual');
  });

  it('handles non-string input', () => {
    expect(classifyContent(null)).toBe('auto');
    expect(classifyContent(undefined)).toBe('auto');
  });
});

describe('maxTier', () => {
  it('returns the stricter tier', () => {
    expect(maxTier('auto', 'review')).toBe('review');
    expect(maxTier('review', 'manual')).toBe('manual');
    expect(maxTier('manual', 'auto')).toBe('manual');
    expect(maxTier('auto', 'auto')).toBe('auto');
  });
});
