/**
 * Fixture corpus for the vision review layer (roadmap p1.4): scripted verdicts standing in for the
 * design checks a vision model or a house reviewer makes against the Degent guidelines (Pepe, tuxedo,
 * mandatory bow tie, frame, placard reading DEGEN/DEGENT/REGEN) plus the moderation rules
 * (`domain/guidelines.ts`). Run through `CompositeArtReview` with `FakeVisionReview` in
 * `test/review-corpus.test.ts`, asserting zero false approvals and that a skipped or failed check never
 * yields `approved: true` (`needsHuman: true` instead).
 */
import type { ReviewVerdict } from '../../src/ports/art-review.js';

export interface VisionFixture {
  name: string;
  verdict: ReviewVerdict;
  /** 'approve': satisfies every guideline. 'reject': an active, reasoned no. 'skip': could not be checked. */
  kind: 'approve' | 'reject' | 'skip';
}

const approve = (detail = 'approved by fake vision'): ReviewVerdict => ({
  approved: true,
  needsHuman: false,
  reasons: [],
  checks: [{ id: 'guidelines', passed: true, detail }],
});
const reject = (...reasons: string[]): ReviewVerdict => ({
  approved: false,
  needsHuman: false,
  reasons,
  checks: [{ id: 'guidelines', passed: false, detail: reasons.join('; ') }],
});
const skip = (detail: string): ReviewVerdict => ({
  approved: false,
  needsHuman: true,
  reasons: [],
  checks: [{ id: 'guidelines', passed: false, detail }],
});

export const VISION_CORPUS: VisionFixture[] = [
  // ---------------------------------------------------------------------------- compliant
  { name: 'Pepe in tuxedo with bow tie, framed, placard reads DEGEN', verdict: approve(), kind: 'approve' },
  { name: 'Pepe in tuxedo with bow tie, framed, placard reads DEGENT', verdict: approve(), kind: 'approve' },
  { name: 'Pepe in tuxedo with bow tie, framed, placard reads REGEN', verdict: approve('approved: rule 4 satisfied with REGEN'), kind: 'approve' },

  // ---------------------------------------------------------------------------- rule 1: subject
  { name: 'not Pepe: a different frog character', verdict: reject('rule 1: the subject is not Pepe the Frog'), kind: 'reject' },
  { name: 'not Pepe: a human in a tuxedo', verdict: reject('rule 1: the subject is a human, not Pepe the Frog'), kind: 'reject' },

  // ---------------------------------------------------------------------------- rule 2: tuxedo + mandatory bow tie
  { name: 'Pepe with no tuxedo at all', verdict: reject('rule 2: Pepe is not wearing a tuxedo'), kind: 'reject' },
  { name: 'Pepe in a tuxedo but a necktie instead of a bow tie', verdict: reject('rule 2: wearing a necktie, not a bow tie'), kind: 'reject' },
  { name: 'Pepe in a tuxedo with an open collar, no tie', verdict: reject('rule 2: open collar, no bow tie'), kind: 'reject' },

  // ---------------------------------------------------------------------------- rule 3: framed
  { name: 'no picture frame or border', verdict: reject('rule 3: the artwork is not framed'), kind: 'reject' },

  // ---------------------------------------------------------------------------- rule 4: placard
  { name: 'framed but no placard at all', verdict: reject('rule 4: no placard is visible'), kind: 'reject' },
  { name: 'placard misspelled (DEGNET)', verdict: reject('rule 4: placard reads DEGNET, which is not DEGEN, DEGENT or REGEN'), kind: 'reject' },
  { name: 'placard reads an unrelated word', verdict: reject('rule 4: placard reads CLUB, not DEGEN, DEGENT or REGEN'), kind: 'reject' },

  // ---------------------------------------------------------------------------- multiple simultaneous failures
  { name: 'wrong subject and no bow tie at once', verdict: reject('rule 1: not Pepe', 'rule 2: no bow tie'), kind: 'reject' },

  // ---------------------------------------------------------------------------- moderation rules (a-f)
  { name: 'moderation: scam QR code soliciting funds', verdict: reject('rule e: QR code directing viewers to send funds'), kind: 'reject' },
  { name: 'moderation: hate symbol present', verdict: reject('rule c: contains a hate symbol'), kind: 'reject' },
  { name: 'moderation: essentially blank / solid colour image', verdict: reject('rule f: essentially blank with no discernible artwork'), kind: 'reject' },

  // ---------------------------------------------------------------------------- refusal (an active no, not a skip)
  { name: 'the model refused to look at the image', verdict: reject('automated review declined this image'), kind: 'reject' },

  // ---------------------------------------------------------------------------- skipped / could not be checked
  { name: 'skipped: unsupported image format for the model', verdict: skip('vision review skipped: image/avif is not supported by the model; a house reviewer will look at it'), kind: 'skip' },
  { name: 'skipped: oversized image, no downscaler available', verdict: skip('vision review skipped: 4000000 bytes exceeds the model image limit and no downscaler could shrink it; a house reviewer will look at it'), kind: 'skip' },
  { name: 'skipped: no vision reviewer configured at all', verdict: skip('vision review not configured: the design rules (Pepe, tuxedo, bow tie, frame, placard) need a house reviewer'), kind: 'skip' },
];
