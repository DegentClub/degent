/**
 * Draft texts built only from Register facts (number, bytes, height, counts). House style from brain/BRAIN.md:
 * "the Club", "Degent", verifiable facts, no prices, no projections, no addresses. Numbers carry thousands
 * separators ("Degent #4,113"). Every draft still goes through the classifier; facts with numbers are review tier.
 */
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Decimal units, as block explorers print them: 372 KB, 3.96 MB, 1.51 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('formatBytes: bytes must be a non-negative number');
  if (bytes < 1000) return `${fmt(bytes)} bytes`;
  if (bytes < 1e6) return `${fmt(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(2).replace(/\.?0+$/, '')} MB`;
  return `${(bytes / 1e9).toFixed(2).replace(/\.?0+$/, '')} GB`;
}

export function memberJoinedText(m: { n: number; bytes: number; height: number | null }): string {
  const where = m.height === null ? 'on chain' : `block ${fmt(m.height)}`;
  return `Degent #${fmt(m.n)} joined the Club. ${formatBytes(m.bytes)}, ${where}.`;
}

export function milestoneText(s: { milestone: number; charter: number; totalBytes: number }): string {
  return `${fmt(s.milestone)} of ${fmt(s.charter)} Degents. ${formatBytes(s.totalBytes)} written to Bitcoin, every byte verifiable with a node.`;
}

export function weeklyText(w: { count: number; medianBytes: number; minted: number; charter: number }): string {
  const who = w.count === 1 ? '1 Degent' : `${fmt(w.count)} Degents`;
  return `This week ${who} joined the Club. Median size ${formatBytes(w.medianBytes)}. ${fmt(w.minted)} of ${fmt(w.charter)} on chain.`;
}
