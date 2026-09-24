/** Ported from Degent-X-Bot test/content-safety.test.js. */
import { describe, expect, it } from 'vitest';
import { appendDisclaimer, canAutoPost, checkSafety, gateContent } from '../src/content/safety.js';
import type { Tier } from '../src/content/classifier.js';

describe('checkSafety', () => {
  it('passes clean content', () => {
    const r = checkSafety('gm, gentlemen. the market awaits.');
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails on a real bech32 address (regression: the old regex never matched bc1q...)', () => {
    const r = checkSafety('send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    expect(r.pass).toBe(false);
    expect(r.failures).toContain('noWalletAddresses');
  });

  it('fails on a taproot address', () => {
    expect(checkSafety('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr').failures).toContain('noWalletAddresses');
  });

  it('does not false-positive on "bc1" as a word', () => {
    expect(checkSafety('bc1 addresses are the future').checks.noWalletAddresses).toBe(true);
  });

  it.each([
    ['x'.repeat(281), 'withinCharLimit'],
    ['#a #b #c', 'noExcessiveHashtags'],
    ['pump it', 'noBannedWords'],
    ['rug pull incoming', 'noBannedWords'],
    ['   ', 'notEmpty'],
    ['guaranteed', 'noFinancialAdvice'],
    ['this is financial advice', 'noFinancialAdvice'],
  ])('%j fails %s', (text, check) => {
    expect(checkSafety(text).failures).toContain(check);
  });

  it('honours custom limits', () => {
    expect(checkSafety('#a #b #c', { maxHashtags: 3 }).pass).toBe(true);
    expect(checkSafety('hello', { maxLength: 4 }).failures).toEqual(['withinCharLimit']);
    expect(checkSafety('ser', { bannedWords: ['ser'] }).failures).toEqual(['noBannedWords']);
  });
});

describe('canAutoPost', () => {
  it.each([
    ['manual', false, false],
    ['manual', true, false],
    ['review', false, false],
    ['review', true, false],
    ['auto', false, true],
    ['auto', true, false],
  ] as Array<[Tier, boolean, boolean]>)('%s with reviewQueueEnabled=%s -> %s', (tier, queue, want) => {
    expect(canAutoPost(tier, { reviewQueueEnabled: queue })).toBe(want);
  });

  it('unset is not "off"', () => {
    expect(canAutoPost('auto', {})).toBe(false);
  });
});

describe('appendDisclaimer', () => {
  it('appends NFA to review-tier market talk', () => {
    expect(appendDisclaimer('1.5 GB of blockspace and counting.', 'review')).toEqual({ text: '1.5 GB of blockspace and counting. NFA.', appended: true });
  });

  it('does not append to review-tier content without market language', () => {
    expect(appendDisclaimer('gentlemen, a partnership.', 'review').appended).toBe(false);
    expect(appendDisclaimer('Degent #4,113 joined the Club. 372 KB, block 912,345.', 'review').appended).toBe(false);
  });

  it('never appends to manual tier', () => {
    expect(appendDisclaimer('floor will 10x', 'manual')).toEqual({ text: 'floor will 10x', appended: false });
  });

  it('leaves auto tier untouched', () => {
    expect(appendDisclaimer('gm, gentlemen.', 'auto')).toEqual({ text: 'gm, gentlemen.', appended: false });
  });

  it('does not duplicate an existing NFA', () => {
    expect(appendDisclaimer('mint count 4,113. NFA', 'review').appended).toBe(false);
    expect(appendDisclaimer('mint count 4,113. not financial advice', 'review').appended).toBe(false);
  });

  it('does not push a post over 280 chars', () => {
    const long = `${'blockspace '.repeat(25)}fees`.slice(0, 278);
    const r = appendDisclaimer(long, 'review');
    expect(r.appended).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(280);
  });

  it('trims trailing whitespace and tolerates non-strings', () => {
    expect(appendDisclaimer('gm   ', 'auto').text).toBe('gm');
    expect(appendDisclaimer(undefined, 'review')).toEqual({ text: '', appended: false });
  });
});

describe('gateContent', () => {
  it('auto tier + queue off -> approved, autoPost', () => {
    expect(gateContent('gm, gentlemen. the market awaits.', { reviewQueueEnabled: false })).toMatchObject({ tier: 'auto', status: 'approved', autoPost: true });
  });

  it('auto tier + queue on (or unset) -> pending', () => {
    expect(gateContent('gm, gentlemen. the market awaits.', { reviewQueueEnabled: true })).toMatchObject({ tier: 'auto', status: 'pending', autoPost: false });
    expect(gateContent('gm, gentlemen.', {})).toMatchObject({ status: 'pending', autoPost: false });
  });

  it('review tier -> pending even with the queue off, with NFA appended', () => {
    const g = gateContent('4,113 of 10,000 minted. 1.5 GB of blockspace.', { reviewQueueEnabled: false });
    expect(g).toMatchObject({ tier: 'review', status: 'pending', autoPost: false });
    expect(g.text).toMatch(/NFA\.$/);
  });

  it('manual tier -> pending, never autoPost, no NFA laundering', () => {
    const g = gateContent('$12.8M at completion', { reviewQueueEnabled: false });
    expect(g).toMatchObject({ tier: 'manual', status: 'pending', autoPost: false });
    expect(g.text).not.toMatch(/NFA/);
  });

  it('a safety failure blocks auto-post even for auto tier', () => {
    const g = gateContent('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', { reviewQueueEnabled: false });
    expect(g).toMatchObject({ tier: 'auto', autoPost: false, status: 'pending' });
    expect(g.safety.failures).toContain('noWalletAddresses');
  });

  it('a clean reply auto-posts only with the queue off', () => {
    expect(gateContent('those who know, know.', { contentType: 'reply', reviewQueueEnabled: false })).toMatchObject({ reasons: ['reply'], autoPost: true });
  });
});
