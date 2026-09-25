/**
 * Roadmap p1.4: a fixture corpus of compliant and non-compliant submissions (test/fixtures/) run over
 * RulesArtReview (the deterministic layer, real image headers) and, for the vision layer, over
 * CompositeArtReview with a scripted FakeVisionReview standing in for the Pepe/tuxedo/bow-tie/frame/placard
 * checks. Exit criterion (plan §1, ADR-0007 §3): zero false approvals on the corpus, and every rejection
 * carries a human-readable reason; for the vision layer, a skipped or failed check never yields `approved`.
 */
import { describe, expect, it } from 'vitest';
import { CompositeArtReview, RulesArtReview } from '../src/adapters/rules-art-review.js';
import { squareArt } from './fakes/images.js';
import { FakeVisionReview } from './fakes/misc.js';
import { RULES_CORPUS } from './fixtures/rules-corpus.js';
import { VISION_CORPUS } from './fixtures/vision-corpus.js';

const rules = new RulesArtReview();
const ruleInput = (f: { declaredContentType: string; bytes: Uint8Array }) => ({ artworkId: 'corpus', declaredContentType: f.declaredContentType, bytes: f.bytes });
// A submission that already satisfies every automated rule, so the vision-corpus test isolates the vision
// verdict: whatever CompositeArtReview does with it is entirely down to what the (fake) vision layer says.
const compliantInput = () => ruleInput({ declaredContentType: 'image/jpeg', bytes: squareArt() });

describe('p1.4: RulesArtReview over the fixture corpus - zero false approvals', () => {
  it.each(RULES_CORPUS.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    const r = await rules.review(ruleInput(f));
    expect(r.needsHuman).toBe(false); // the rules layer never asks for a human: it decides
    expect(r.approved).toBe(f.compliant);
    const failing = r.checks.filter((c) => !c.passed);
    if (f.compliant) {
      expect(failing).toEqual([]);
      expect(r.reasons).toEqual([]);
    } else {
      // every rejection carries a human-readable reason, one per failing check
      expect(failing.length).toBeGreaterThan(0);
      for (const c of failing) expect(typeof c.detail).toBe('string');
      for (const c of failing) expect(c.detail.length).toBeGreaterThan(0);
      expect(r.reasons).toEqual(failing.map((c) => c.detail));
      if (f.expectFailing) expect(failing.map((c) => c.id).sort()).toEqual([...f.expectFailing].sort());
    }
  });

  it('the corpus itself is non-trivial: both compliant and non-compliant fixtures are represented', () => {
    expect(RULES_CORPUS.filter((f) => f.compliant).length).toBeGreaterThanOrEqual(5);
    expect(RULES_CORPUS.filter((f) => !f.compliant).length).toBeGreaterThanOrEqual(8);
  });

  it('zero false approvals across the whole corpus in one pass', async () => {
    const results = await Promise.all(RULES_CORPUS.map((f) => rules.review(ruleInput(f))));
    const falseApprovals = RULES_CORPUS.filter((f, i) => !f.compliant && results[i]!.approved).map((f) => f.name);
    expect(falseApprovals).toEqual([]);
  });
});

describe('p1.4: vision layer over the fixture corpus - a skipped or failed check never approves', () => {
  it.each(VISION_CORPUS.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    const composite = new CompositeArtReview([rules, new FakeVisionReview(f.verdict)]);
    const r = await composite.review(compliantInput());
    if (f.kind === 'approve') {
      expect(r).toMatchObject({ approved: true, needsHuman: false, reasons: [] });
    } else {
      expect(r.approved).toBe(false); // zero false approvals, whether an active rejection or a skip
      if (f.kind === 'skip') expect(r.needsHuman).toBe(true); // skipped -> needsHuman, never a silent pass
      else expect(r.needsHuman).toBe(false); // an active rejection needs no human to say no
    }
  });

  it('the corpus covers every named guideline (Pepe, tuxedo, bow tie, frame, placard) plus a skip', () => {
    const names = VISION_CORPUS.map((f) => f.name.toLowerCase()).join(' | ');
    for (const term of ['pepe', 'tuxedo', 'bow tie', 'frame', 'placard', 'skipped']) expect(names).toContain(term);
    expect(VISION_CORPUS.some((f) => f.kind === 'skip')).toBe(true);
    expect(VISION_CORPUS.some((f) => f.kind === 'approve')).toBe(true);
  });

  it('zero false approvals across the whole vision corpus, run through the composite in one pass', async () => {
    const outcomes = await Promise.all(
      VISION_CORPUS.map(async (f) => ({ f, r: await new CompositeArtReview([rules, new FakeVisionReview(f.verdict)]).review(compliantInput()) })),
    );
    const falseApprovals = outcomes.filter(({ f, r }) => f.kind !== 'approve' && r.approved).map(({ f }) => f.name);
    expect(falseApprovals).toEqual([]);
    // and every skip specifically produced needsHuman, never a bare rejection standing in for it
    const wrongSkip = outcomes.filter(({ f, r }) => f.kind === 'skip' && !r.needsHuman).map(({ f }) => f.name);
    expect(wrongSkip).toEqual([]);
  });

  it('a real rules failure still short-circuits before the vision layer, corpus verdict notwithstanding', async () => {
    // Sanity: the vision corpus is only meaningful once the automated rules already pass. Pairing a
    // non-compliant image with even an "approve" scripted vision verdict must still end in a rejection.
    const nonSquare = RULES_CORPUS.find((f) => f.expectFailing?.includes('square'))!;
    const vision = new FakeVisionReview(VISION_CORPUS.find((f) => f.kind === 'approve')!.verdict);
    const composite = new CompositeArtReview([rules, vision]);
    const r = await composite.review(ruleInput(nonSquare));
    expect(r.approved).toBe(false);
    expect(vision.calls).toHaveLength(0);
  });
});
