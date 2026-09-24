/**
 * The Minting Rules checklist shown next to every Atelier candidate and upload (pure).
 * Each rule is `pass` (measured from the exact bytes or a review), `fail`, `construction` (true by
 * how the Atelier builds it, e.g. the prompt scaffold), `attested` (you confirmed it for your own
 * art) or `pending` (checked at a later stage).
 */
import type { AtelierReview, Placard } from '../services/types';

export type RuleState = 'pass' | 'fail' | 'construction' | 'attested' | 'pending';

export interface RuleRow {
  id: 'format' | 'design' | 'frame' | 'quantity';
  title: string;
  state: RuleState;
  detail: string;
}

export interface FinalFacts {
  contentType: string | null;
  width: number | null;
  height: number | null;
  size: number;
}

export interface RulesInput {
  /** generate: AI candidates; upload-frame: compositor frames your art; upload-asis: your bytes unchanged. */
  path: 'generate' | 'upload-frame' | 'upload-asis';
  /** A candidate is selected (generate path). */
  candidate?: boolean;
  /** Vision review of the candidate or the final bytes, when the Atelier ran one. */
  review?: AtelierReview | null;
  final?: FinalFacts | null;
  placard?: Placard | null;
  attest?: { design?: boolean; frame?: boolean };
}

const MIN_BYTES = 200_000;

function reviewSays(review: AtelierReview | null | undefined, ids: RegExp): boolean | null {
  const hits = review?.checks.filter((c) => ids.test(c.id)) ?? [];
  if (hits.length === 0) return null;
  return hits.every((c) => c.passed);
}

export function rulesStatus(i: RulesInput): RuleRow[] {
  const f = i.final ?? null;
  let format: RuleRow;
  if (f) {
    const square = !!f.width && f.width === f.height;
    const jpeg = f.contentType === 'image/jpeg';
    const big = f.size >= MIN_BYTES;
    const problems = [!jpeg && `${f.contentType ?? 'unknown format'} (JPEG recommended)`, !square && `${f.width ?? '?'}×${f.height ?? '?'} is not square`, !big && `${f.size.toLocaleString('en-US')} bytes is under 200 KB`].filter(Boolean);
    // JPEG is the recommended format; the mint also accepts PNG/WebP/AVIF/GIF, so a non-JPEG square ≥ 200 KB is not a failure.
    format = {
      id: 'format',
      title: 'Square JPEG, at least 200 KB',
      state: square && big ? 'pass' : 'fail',
      detail: problems.length ? problems.join(' · ') : `${f.width}×${f.height} JPEG, ${f.size.toLocaleString('en-US')} bytes`,
    };
  } else {
    format = { id: 'format', title: 'Square JPEG, at least 200 KB', state: 'pending', detail: 'measured on the final bytes' };
  }

  const designReview = reviewSays(i.review, /pepe|tux|bow/i);
  let design: RuleRow;
  if (designReview !== null) design = { id: 'design', title: 'Pepe in a tuxedo with a bow tie', state: designReview ? 'pass' : 'fail', detail: 'vision review' };
  else if (i.path === 'generate')
    design = { id: 'design', title: 'Pepe in a tuxedo with a bow tie', state: i.candidate ? 'construction' : 'pending', detail: 'fixed in the prompt scaffold; check the picture yourself' };
  else
    design = {
      id: 'design',
      title: 'Pepe in a tuxedo with a bow tie',
      state: i.attest?.design ? 'attested' : 'pending',
      detail: i.attest?.design ? 'you confirmed it' : 'confirm it for your art',
    };

  let frame: RuleRow;
  if (i.path === 'upload-asis')
    frame = {
      id: 'frame',
      title: 'Framed, with a DEGEN / DEGENT / REGEN placard',
      state: i.attest?.frame ? 'attested' : 'pending',
      detail: i.attest?.frame ? 'you confirmed your art has both' : 'confirm your art has a frame and placard',
    };
  else
    frame = {
      id: 'frame',
      title: 'Framed, with a DEGEN / DEGENT / REGEN placard',
      state: f ? (i.placard ? 'pass' : 'fail') : i.placard ? 'construction' : 'pending',
      detail: f ? `gold frame + “${i.placard ?? '—'}” placard drawn by the compositor` : `the compositor adds the frame and “${i.placard ?? '…'}” at finalize`,
    };

  const quantity: RuleRow = { id: 'quantity', title: 'Mint as many as you want', state: 'pass', detail: 'no per-wallet cap' };
  return [format, design, frame, quantity];
}

/** Ready to hand to the mint: every rule passes, holds by construction, or is attested. */
export function rulesOk(rows: RuleRow[]): boolean {
  return rows.every((r) => r.state === 'pass' || r.state === 'construction' || r.state === 'attested');
}
