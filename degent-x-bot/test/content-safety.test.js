import { describe, it, expect, vi } from 'vitest';

import { mockRequire, requireFresh } from './helpers/mock-require';

mockRequire('../src/lib/logger', { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() });
const { checkSafety, canAutoPost, appendDisclaimer, gateContent } = requireFresh('../src/lib/content-safety');

describe('checkSafety', () => {
  it('passes clean content', () => {
    const r = checkSafety('gm, gentlemen. the market awaits.');
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails on a real bech32 address (regression: old regex never matched bc1q...)', () => {
    const r = checkSafety('send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    expect(r.pass).toBe(false);
    expect(r.failures).toContain('noWalletAddresses');
  });

  it('fails on a taproot address', () => {
    const r = checkSafety('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
    expect(r.failures).toContain('noWalletAddresses');
  });

  it('does not false-positive on "bc1" as a word', () => {
    const r = checkSafety('bc1 addresses are the future');
    expect(r.checks.noWalletAddresses).toBe(true);
  });

  it('enforces length, hashtags and banned words', () => {
    expect(checkSafety('x'.repeat(281)).failures).toContain('withinCharLimit');
    expect(checkSafety('#a #b #c').failures).toContain('noExcessiveHashtags');
    expect(checkSafety('pump it').failures).toContain('noBannedWords');
    expect(checkSafety('   ').failures).toContain('notEmpty');
  });
});

describe('canAutoPost', () => {
  it('never auto-posts manual tier', () => {
    expect(canAutoPost('manual', { reviewQueueEnabled: false })).toBe(false);
    expect(canAutoPost('manual', { reviewQueueEnabled: true })).toBe(false);
  });

  it('never auto-posts review tier', () => {
    expect(canAutoPost('review', { reviewQueueEnabled: false })).toBe(false);
    expect(canAutoPost('review', { reviewQueueEnabled: true })).toBe(false);
  });

  it('auto-posts auto tier only when the review queue is off', () => {
    expect(canAutoPost('auto', { reviewQueueEnabled: false })).toBe(true);
    expect(canAutoPost('auto', { reviewQueueEnabled: true })).toBe(false);
    expect(canAutoPost('auto', {})).toBe(false); // undefined is not "off"
  });
});

describe('appendDisclaimer', () => {
  it('appends NFA to review-tier market talk', () => {
    const r = appendDisclaimer('1.5 GB of blockspace and counting.', 'review');
    expect(r.appended).toBe(true);
    expect(r.text).toBe('1.5 GB of blockspace and counting. NFA.');
  });

  it('does not append to review-tier content without market language', () => {
    const r = appendDisclaimer('gentlemen, a partnership.', 'review');
    expect(r.appended).toBe(false);
  });

  it('never appends to manual tier', () => {
    const r = appendDisclaimer('floor will 10x', 'manual');
    expect(r.appended).toBe(false);
    expect(r.text).toBe('floor will 10x');
  });

  it('leaves auto tier untouched', () => {
    const r = appendDisclaimer('gm, gentlemen.', 'auto');
    expect(r.appended).toBe(false);
    expect(r.text).toBe('gm, gentlemen.');
  });

  it('does not duplicate an existing NFA', () => {
    const r = appendDisclaimer('mint count 4,113. NFA', 'review');
    expect(r.appended).toBe(false);
  });

  it('does not push a tweet over 280 chars', () => {
    const long = `${'blockspace '.repeat(25)}fees`.slice(0, 278);
    const r = appendDisclaimer(long, 'review');
    expect(r.appended).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(280);
  });
});

describe('gateContent', () => {
  it('auto tier + queue off -> approved, autoPost', () => {
    const g = gateContent('gm, gentlemen. the market awaits.', { reviewQueueEnabled: false });
    expect(g).toMatchObject({ tier: 'auto', status: 'approved', autoPost: true });
  });

  it('auto tier + queue on -> pending', () => {
    const g = gateContent('gm, gentlemen. the market awaits.', { reviewQueueEnabled: true });
    expect(g).toMatchObject({ tier: 'auto', status: 'pending', autoPost: false });
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

  it('safety failure blocks auto-post even for auto tier', () => {
    const g = gateContent('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', { reviewQueueEnabled: false });
    expect(g.tier).toBe('auto');
    expect(g.autoPost).toBe(false);
    expect(g.status).toBe('pending');
    expect(g.safety.failures).toContain('noWalletAddresses');
  });
});
