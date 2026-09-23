/** Pure formatting helpers. Numbers that matter (sats, bytes, hashes) are always shown exactly. */

const SATS_PER_BTC = 100_000_000;

export function groupDigits(n: number | bigint): string {
  const s = (typeof n === 'bigint' ? n : BigInt(Math.round(n))).toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

export function formatSats(n: number | bigint): string {
  return `${groupDigits(n)} sats`;
}

/** Exact 8-decimal BTC string from integer sats (no float rounding). */
export function formatBtc(n: number | bigint): string {
  const sats = typeof n === 'bigint' ? n : BigInt(Math.round(n));
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / BigInt(SATS_PER_BTC);
  const frac = (abs % BigInt(SATS_PER_BTC)).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac} BTC`;
}

/** kB/MB use SI units (1 kB = 1,000 bytes) to match Bitcoin weight maths. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function formatBytesExact(bytes: number): string {
  return `${groupDigits(bytes)} bytes`;
}

export function formatFeeRate(rate: number): string {
  const r = Number.isInteger(rate) ? rate.toString() : rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${r} sat/vB`;
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

export function formatEta(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `~${h} h` : `~${h} h ${m} min`;
}

export function shortHash(h: string, keep = 8): string {
  return h.length <= keep * 2 + 1 ? h : `${h.slice(0, keep)}…${h.slice(-keep)}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
