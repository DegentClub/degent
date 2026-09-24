/**
 * INDICATIVE cost context for the tier tables (How it works, Atelier). Inscription content is
 * witness data, ~1 weight unit per byte, so a reveal is roughly bytes / 4 vbytes. This is a rough
 * guide printed with "≈"; the binding number is the mint's quote, computed with @bsh/inscription
 * from the exact bytes on the Quote step.
 */
export function indicativeRevealVbytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function indicativeRevealSats(bytes: number, feeRate: number): number {
  return Math.ceil(indicativeRevealVbytes(bytes) * feeRate);
}

export function formatSatsShort(sats: number): string {
  if (sats >= 1_000_000) return `${(sats / 100_000_000).toFixed(sats >= 10_000_000 ? 2 : 3)} BTC`;
  return `${sats.toLocaleString('en-US')} sats`;
}
