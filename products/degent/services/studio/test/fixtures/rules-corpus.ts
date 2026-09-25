/**
 * Fixture corpus for RulesArtReview (roadmap p1.4): deterministic, compliant and non-compliant
 * submissions built from real (but synthetic, no binary assets committed) image headers via
 * `test/fakes/images.ts`. Every fixture states whether it satisfies the published Degent rules and,
 * for the non-compliant ones, which check id(s) must be among the failures. `test/review-corpus.test.ts`
 * asserts zero false approvals over this corpus and that every rejection carries a reason.
 */
import { avif, gif, jpeg, png } from '../fakes/images.js';

export interface RulesFixture {
  name: string;
  declaredContentType: string;
  bytes: Uint8Array;
  /** Whether this submission satisfies every automated (non-vision) Degent rule. */
  compliant: boolean;
  /** For non-compliant fixtures: check ids that must be among the failing checks. */
  expectFailing?: string[];
}

export const RULES_CORPUS: RulesFixture[] = [
  // ---------------------------------------------------------------------------- compliant
  { name: 'square jpeg, mid-range size and dimensions', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 300_000), compliant: true },
  { name: 'square png, small end of the standard tier', declaredContentType: 'image/png', bytes: png(1024, 1024, 210_000), compliant: true },
  { name: 'square png, top of the full-block tier', declaredContentType: 'image/png', bytes: png(4096, 4096, 3_900_000), compliant: true },
  { name: 'square gif, mid-range', declaredContentType: 'image/gif', bytes: gif(1024, 1024, 250_000), compliant: true },
  { name: 'square avif, mid-range', declaredContentType: 'image/avif', bytes: avif(1024, 1024, 1_000_000), compliant: true },
  { name: 'smallest legal dimensions, comfortably in-tier size', declaredContentType: 'image/jpeg', bytes: jpeg(256, 256, 210_000), compliant: true },
  { name: 'largest legal dimensions, top of the full-block tier', declaredContentType: 'image/jpeg', bytes: jpeg(4096, 4096, 3_900_000), compliant: true },

  // ---------------------------------------------------------------------------- wrong aspect ratio
  { name: 'wide rectangle, not square', declaredContentType: 'image/jpeg', bytes: jpeg(1200, 800, 300_000), compliant: false, expectFailing: ['square'] },
  { name: 'tall rectangle, not square', declaredContentType: 'image/png', bytes: png(800, 1200, 300_000), compliant: false, expectFailing: ['square'] },
  { name: 'off by a single pixel', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1023, 300_000), compliant: false, expectFailing: ['square'] },

  // ---------------------------------------------------------------------------- too small / too large dimensions
  { name: 'dimensions below the 256px floor', declaredContentType: 'image/jpeg', bytes: jpeg(100, 100, 250_000), compliant: false, expectFailing: ['width', 'height'] },
  { name: 'dimensions above the 4096px ceiling', declaredContentType: 'image/jpeg', bytes: jpeg(5000, 5000, 3_900_000), compliant: false, expectFailing: ['width', 'height'] },
  { name: 'gif dimensions below the floor', declaredContentType: 'image/gif', bytes: gif(64, 64, 250_000), compliant: false, expectFailing: ['width', 'height'] },

  // ---------------------------------------------------------------------------- wrong mime (declared vs real bytes)
  { name: 'declared png, actually a jpeg', declaredContentType: 'image/png', bytes: jpeg(1024, 1024, 300_000), compliant: false, expectFailing: ['magic_bytes'] },
  { name: 'declared jpeg, actually a png', declaredContentType: 'image/jpeg', bytes: png(1024, 1024, 300_000), compliant: false, expectFailing: ['magic_bytes'] },
  {
    name: 'declared jpeg, actually an svg (not a recognised image at all)',
    declaredContentType: 'image/jpeg',
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(250_000, ' ')),
    compliant: false,
    expectFailing: ['magic_bytes', 'dimensions_readable'],
  },
  {
    name: 'jpeg magic bytes with no SOF marker: dimensions unreadable',
    declaredContentType: 'image/jpeg',
    bytes: (() => {
      const b = new Uint8Array(250_000);
      b.set([0xff, 0xd8, 0xff, 0xd9]);
      return b;
    })(),
    compliant: false,
    expectFailing: ['dimensions_readable'],
  },

  // ---------------------------------------------------------------------------- out of the size tiers
  { name: 'below every tier (too small)', declaredContentType: 'image/jpeg', bytes: jpeg(1024, 1024, 50_000), compliant: false, expectFailing: ['size'] },
  { name: 'above every tier (too large)', declaredContentType: 'image/png', bytes: png(4096, 4096, 4_000_000), compliant: false, expectFailing: ['size'] },
  { name: 'avif above every tier', declaredContentType: 'image/avif', bytes: avif(4096, 4096, 4_000_000), compliant: false, expectFailing: ['size'] },
];
