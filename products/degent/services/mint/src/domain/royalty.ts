/**
 * Pure Open Studio money checks (plan §3.3). The worker compares SCRIPTS, never address strings, and sums
 * every output paying a script, so a wallet that splits an output still pays. No I/O.
 */
import type { ChainTxOutput } from '../ports/chain.js';

export interface FundingCheckInput {
  /** The funding transaction's outputs in vout order. */
  outputs: readonly ChainTxOutput[];
  /** scriptPubKey hex of the artist's payout address; null when no royalty is due. */
  artistScriptHex: string | null;
  artistRoyaltySats: number;
  /** scriptPubKey hex of the club fee address (SERVICE_FEE_ADDRESS); null when no club fee is due. */
  clubScriptHex: string | null;
  clubFeeSats: number;
}

export interface ScriptPayment {
  scriptHex: string;
  expectedSats: number;
  paidSats: number;
  /** Output indexes paying the script, in vout order. */
  vouts: number[];
  ok: boolean;
}

export interface FundingCheck {
  ok: boolean;
  artist: ScriptPayment | null;
  club: ScriptPayment | null;
  /** Human-readable reason naming the missing or short output (empty when ok). */
  detail: string;
}

function sumScript(outputs: readonly ChainTxOutput[], scriptHex: string, expectedSats: number): ScriptPayment {
  const script = scriptHex.toLowerCase();
  let paid = 0n;
  const vouts: number[] = [];
  outputs.forEach((o, i) => {
    if (o.scriptHex.toLowerCase() !== script) return;
    paid += o.value;
    vouts.push(i);
  });
  const paidSats = Number(paid);
  return { scriptHex: script, expectedSats, paidSats, vouts, ok: paidSats >= expectedSats };
}

/** Are the artist and the club paid at least what the quote says, by script? */
export function checkFundingOutputs(i: FundingCheckInput): FundingCheck {
  const artist = i.artistScriptHex && i.artistRoyaltySats > 0 ? sumScript(i.outputs, i.artistScriptHex, i.artistRoyaltySats) : null;
  const club = i.clubScriptHex && i.clubFeeSats > 0 ? sumScript(i.outputs, i.clubScriptHex, i.clubFeeSats) : null;
  const problems: string[] = [];
  if (artist && !artist.ok)
    problems.push(artist.vouts.length === 0 ? `artist royalty output missing (expected ${artist.expectedSats} sats to the artist's payout script)` : `artist royalty short (${artist.paidSats} < ${artist.expectedSats} sats)`);
  if (club && !club.ok) problems.push(club.vouts.length === 0 ? `club fee output missing (expected ${club.expectedSats} sats to the club script)` : `club fee short (${club.paidSats} < ${club.expectedSats} sats)`);
  return { ok: problems.length === 0, artist, club, detail: problems.join('; ') };
}

/** Exponential backoff for the studio / ledger retries: 30 s, 60 s, 2 m, ... capped at 1 h. */
export function retryDelayMs(attempt: number): number {
  const base = 30_000;
  const cap = 60 * 60_000;
  return Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt - 1, 20)));
}
