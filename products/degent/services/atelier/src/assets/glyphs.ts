/**
 * Placard lettering as vector paths. Only the letters the three placard words need (D E G N R T),
 * drawn as stroked paths in a 72x100 em box, so the compositor never depends on a system font
 * (librsvg would silently fall back to whatever fontconfig finds, which differs per host and would
 * break byte-for-byte reproducibility).
 */
export const GLYPH_BOX = { width: 72, height: 100 } as const;
/** Horizontal advance between glyph origins. */
export const GLYPH_ADVANCE = 84;
/** Stroke width used to draw every glyph. */
export const GLYPH_STROKE = 15;

/** Path data per letter (stroked, fill none). Coordinates in the em box. */
export const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  D: 'M 12 8 V 92 H 34 A 42 42 0 0 0 34 8 Z',
  E: 'M 62 8 H 12 V 92 H 62 M 12 50 H 54',
  G: 'M 62 24 A 30 34 0 1 0 62 76 V 54 H 40',
  N: 'M 12 92 V 8 L 60 92 V 8',
  R: 'M 12 92 V 8 H 40 A 21 21 0 0 1 40 50 H 12 M 38 50 L 62 92',
  T: 'M 6 8 H 66 M 36 8 V 92',
});

export function textWidth(text: string): number {
  return text.length === 0 ? 0 : (text.length - 1) * GLYPH_ADVANCE + GLYPH_BOX.width;
}

/**
 * SVG fragment drawing `text` with its top-left at (x, y), scaled so the em height equals `emPx`.
 * Throws for letters without a glyph: the placard words are validated before we get here.
 */
export function textPaths(text: string, x: number, y: number, emPx: number, attrs: string): string {
  const scale = emPx / GLYPH_BOX.height;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const d = GLYPHS[ch];
    if (!d) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
    const tx = x + i * GLYPH_ADVANCE * scale;
    parts.push(`<path d="${d}" transform="translate(${tx.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})" ${attrs}/>`);
  }
  return parts.join('');
}
