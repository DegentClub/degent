/**
 * Local pre-flight checks. Delegates to @bsh/degent-mint-sdk's `validateContentMeta`, the same
 * function the service runs, fed with the service's own CollectionConfig. Running them here means
 * the user sees every failure before uploading, let alone paying.
 */
import { isSha256Hex, sniffContentType, validateContentMeta } from '@bsh/degent-mint-sdk';
import type { CollectionConfig, Tier, TierRule } from '@bsh/degent-mint-sdk';

export interface RuleCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ArtworkFacts {
  bytes: Uint8Array;
  contentType: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
}

const LABELS: Record<string, string> = {
  content_type: 'Allowed image format',
  size: 'Size fits a tier',
  tier: 'Size matches the tier you chose',
  width: 'Width within bounds',
  height: 'Height within bounds',
};

export function tierRule(config: CollectionConfig, tier: Tier): TierRule {
  const rule = config.tiers.find((t) => t.tier === tier);
  if (!rule) throw new Error(`Tier ${tier} is not offered by this collection.`);
  return rule;
}

export function runLocalRules(art: ArtworkFacts, tier: Tier, config: CollectionConfig): RuleCheck[] {
  const v = validateContentMeta(
    { contentType: art.contentType, contentLength: art.size, width: art.width, height: art.height, tier },
    config,
  );
  const checks: RuleCheck[] = v.checks.map((c) => ({ ...c, label: LABELS[c.id] ?? c.id }));
  const sniffed = sniffContentType(art.bytes);
  checks.push({
    id: 'magic_bytes',
    label: 'Bytes really are the declared format',
    passed: sniffed === art.contentType,
    detail: sniffed ? `file header says ${sniffed}` : 'unrecognised file header',
  });
  checks.push({
    id: 'length',
    label: 'Byte count measured from the exact bytes',
    passed: art.bytes.length === art.size,
    detail: `${art.bytes.length} bytes`,
  });
  checks.push({
    id: 'sha256',
    label: 'SHA-256 fingerprint of the exact bytes',
    passed: isSha256Hex(art.sha256),
    detail: art.sha256 || 'missing',
  });
  return checks;
}

export function allPassed(checks: RuleCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}

/** The art brief (carried over from the legacy minter). Self-attested; the automated review checks it. */
export const ART_BRIEF: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'pepe-tuxedo', label: 'Pepe, in a tuxedo', hint: 'The gentleman himself. Formal wear, not a hoodie.' },
  { id: 'bowtie', label: 'Bowtie — mandatory', hint: 'No bowtie, no entry. The doorman is strict.' },
  { id: 'text', label: 'The word “DEGEN”, “DEGENT” or “REGEN” in the art', hint: 'Legible, part of the piece.' },
  { id: 'original', label: 'Your own work, safe for the club', hint: 'No stolen art, no hate, nothing explicit.' },
];
