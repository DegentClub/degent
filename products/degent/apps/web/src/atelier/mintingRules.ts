/**
 * The four Minting Rules from the site spec ("The essential requirements for minting a Degent and joining the
 * club"), evaluated for the design on the table. Sizes, format and dimensions come from
 * @bsh/degent-mint-sdk (`validateContentMeta`), the same rules the service enforces; the design itself is
 * self-attested here and checked by the automated art review.
 */
import { validateContentMeta, type CollectionConfig, type Tier } from '@bsh/degent-mint-sdk';
import { isPlacardText, FRAME_MAX_PCT, FRAME_MIN_PCT } from './composition';

export type MintingRuleId = 'format' | 'design' | 'framing' | 'quantity';

export interface MintingRuleState {
  id: MintingRuleId;
  title: string;
  /** The rule as the club states it (site spec, verbatim). */
  rule: string;
  satisfied: boolean;
  /** How we know: measured from the bytes, confirmed by you (and the review), or always true. */
  how: 'measured' | 'you confirm' | 'always';
  detail: string;
}

export interface MintingRuleInput {
  artwork: { contentType: string; width: number; height: number; size: number } | null;
  tier: Tier;
  config: CollectionConfig;
  /** Set when the Atelier framed the piece. */
  framing: { framePct: number; placard: string } | null;
  briefAck: Record<string, boolean>;
}

export const MINTING_RULES: ReadonlyArray<{ id: MintingRuleId; title: string; rule: string }> = [
  { id: 'format', title: 'File Format & Size', rule: 'Square JPEG format with a minimum size of 200KB.' },
  { id: 'design', title: 'Essential Design', rule: 'Pepe character wearing a tuxedo with a mandatory bowtie.' },
  { id: 'framing', title: 'Framing & Text', rule: 'Must be framed and include a placard that says “DEGEN”, “DEGENT”, or “REGEN”.' },
  { id: 'quantity', title: 'Quantity', rule: 'Mint as many as you want – create your own mini-collection!' },
];

const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;

export function mintingRules(input: MintingRuleInput): MintingRuleState[] {
  const { artwork: a, config, tier } = input;
  const out: MintingRuleState[] = [];
  const text = (id: MintingRuleId) => MINTING_RULES.find((r) => r.id === id)!;

  // 1 · square, allowed format (JPEG recommended), inside the tier's byte range and the pixel bounds
  if (!a) {
    out.push({ ...text('format'), satisfied: false, how: 'measured', detail: 'No design yet.' });
  } else {
    const v = validateContentMeta({ contentType: a.contentType, contentLength: a.size, width: a.width, height: a.height, tier }, config);
    const square = a.width === a.height;
    const jpeg = a.contentType === 'image/jpeg';
    const problems = [
      ...(square ? [] : [`not square (${a.width}×${a.height})`]),
      ...v.checks.filter((c) => !c.passed).map((c) => c.detail),
    ];
    out.push({
      ...text('format'),
      satisfied: square && v.ok,
      how: 'measured',
      detail: problems.length
        ? problems.join('; ')
        : `${a.width}×${a.height} ${jpeg ? 'JPEG' : `${a.contentType.replace('image/', '').toUpperCase()} (accepted; JPEG recommended)`}, ${kb(a.size)}`,
    });
  }

  // 2 · the gentleman himself: self-attested, then the automated review
  const design = !!input.briefAck['pepe-tuxedo'] && !!input.briefAck['bowtie'];
  out.push({
    ...text('design'),
    satisfied: design,
    how: 'you confirm',
    detail: design ? 'Confirmed in the brief; the automated review checks it.' : 'Confirm “Pepe, in a tuxedo” and “Bowtie” in the brief.',
  });

  // 3 · framed with a placard: measured when the Atelier framed it, else self-attested
  const f = input.framing;
  if (f) {
    const ok = f.framePct >= FRAME_MIN_PCT && f.framePct <= FRAME_MAX_PCT && isPlacardText(f.placard);
    out.push({
      ...text('framing'),
      satisfied: ok,
      how: 'measured',
      detail: ok ? `Gold frame ${Math.round(f.framePct)} %, placard “${f.placard}”.` : `Placard must say DEGEN, DEGENT or REGEN.`,
    });
  } else {
    const ack = !!input.briefAck['text'];
    out.push({
      ...text('framing'),
      satisfied: ack,
      how: 'you confirm',
      detail: ack ? 'Confirmed in the brief; the automated review checks it.' : 'Frame it in the Atelier, or confirm the placard text in the brief.',
    });
  }

  // 4 · no per-wallet cap
  out.push({ ...text('quantity'), satisfied: true, how: 'always', detail: 'No per-wallet cap.' });
  return out;
}
