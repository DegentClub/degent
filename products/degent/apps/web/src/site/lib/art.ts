/**
 * Placeholder art for demo mode and the Atelier fake: a deterministic "gentleman" (frog face,
 * tuxedo, bow tie) as SVG, coloured from a seed. It is obviously a placeholder, never mistaken for a
 * real Degent, and needs no network.
 */

export function hashSeed(s: string | number): number {
  const str = String(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BACKDROPS = ['#1d2b4a', '#3b1f47', '#123a33', '#4a2a17', '#2b2b2b', '#16323f', '#3f1a1a', '#233318'];
const SKINS = ['#5fae4e', '#6cbf57', '#4f9b45', '#77c463', '#58a84a'];
const ACCENTS = ['#2efc86', '#f7c948', '#f7931a', '#e8e8e8', '#ff5d8f', '#7cc4ff'];

export interface ArtPalette {
  backdrop: string;
  skin: string;
  accent: string;
}

export function paletteFor(seed: string | number): ArtPalette {
  const h = hashSeed(seed);
  return {
    backdrop: BACKDROPS[h % BACKDROPS.length]!,
    skin: SKINS[(h >>> 3) % SKINS.length]!,
    accent: ACCENTS[(h >>> 7) % ACCENTS.length]!,
  };
}

/** SVG markup (viewBox 0 0 100 100) of a placeholder gentleman. */
export function gentlemanSvg(seed: string | number, opts: { label?: string } = {}): string {
  const p = paletteFor(seed);
  const label = opts.label ? `<text x="50" y="8" font-family="monospace" font-size="5" fill="#ffffff99" text-anchor="middle">${escapeXml(opts.label)}</text>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${p.backdrop}"/>` +
    `<circle cx="50" cy="40" r="40" fill="${p.accent}" opacity="0.08"/>` +
    // shoulders / tuxedo
    `<path d="M14 100 Q16 70 50 66 Q84 70 86 100 Z" fill="#101014"/>` +
    `<path d="M42 67 L50 100 L58 67 Z" fill="#f4f4f4"/>` +
    // head
    `<ellipse cx="50" cy="46" rx="24" ry="20" fill="${p.skin}"/>` +
    `<ellipse cx="39" cy="30" rx="10" ry="9" fill="${p.skin}"/><ellipse cx="61" cy="30" rx="10" ry="9" fill="${p.skin}"/>` +
    `<circle cx="39" cy="30" r="6" fill="#fff"/><circle cx="61" cy="30" r="6" fill="#fff"/>` +
    `<circle cx="40" cy="31" r="3" fill="#111"/><circle cx="62" cy="31" r="3" fill="#111"/>` +
    `<path d="M36 54 Q50 62 64 54" stroke="#7a2a2a" stroke-width="2.5" fill="none" stroke-linecap="round"/>` +
    // bow tie (mandatory)
    `<path d="M50 70 L38 64 L38 76 Z M50 70 L62 64 L62 76 Z" fill="${p.accent}"/><rect x="47" y="67" width="6" height="6" rx="1" fill="${p.accent}"/>` +
    label +
    `</svg>`
  );
}

export function gentlemanDataUrl(seed: string | number, opts: { label?: string } = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(gentlemanSvg(seed, opts))}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
