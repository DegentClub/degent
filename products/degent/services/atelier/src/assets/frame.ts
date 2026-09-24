/**
 * The gold gallery frame and the placard, as an SVG overlay generated for a given canvas size.
 * The centre is transparent: the compositor draws the art first and this on top. All geometry is
 * proportional to the canvas so 1024 px and 4096 px renders look identical.
 */
import { GLYPH_ADVANCE, GLYPH_STROKE, textPaths, textWidth } from './glyphs.js';

export interface FrameGeometry {
  /** Canvas edge length in px. */
  size: number;
  /** Width of the frame rail (art opening is inset by this on every side). */
  rail: number;
  /** Art opening, in px. */
  opening: { x: number; y: number; width: number; height: number };
  /** Placard plate rectangle. */
  placard: { x: number; y: number; width: number; height: number };
}

/** Proportions of the design (fractions of the canvas edge). */
export const FRAME_RAIL_FRACTION = 0.085;
const PLACARD_HEIGHT_FRACTION = 0.082;
const PLACARD_MIN_WIDTH_FRACTION = 0.3;

export function frameGeometry(size: number, placardText: string): FrameGeometry {
  const rail = Math.round(size * FRAME_RAIL_FRACTION);
  const ph = Math.round(size * PLACARD_HEIGHT_FRACTION);
  const em = ph * 0.52;
  const tw = (textWidth(placardText) / 100) * em;
  const pw = Math.round(Math.max(size * PLACARD_MIN_WIDTH_FRACTION, tw + em * 1.4));
  const px = Math.round((size - pw) / 2);
  // The plate sits on the bottom rail and overlaps the art edge a little, like a real plaque.
  const py = Math.round(size - rail - ph * 0.42);
  return {
    size,
    rail,
    opening: { x: rail, y: rail, width: size - 2 * rail, height: size - 2 * rail },
    placard: { x: px, y: py, width: pw, height: ph },
  };
}

const f = (n: number) => n.toFixed(2);

/** Build the overlay SVG (frame ring + ornaments + placard with engraved lettering). */
export function frameSvg(geom: FrameGeometry, placardText: string): string {
  const { size: S, rail: R } = geom;
  const o = geom.opening;
  const p = geom.placard;
  const edge = Math.max(2, R * 0.12); // outer dark bevel
  const lip = Math.max(2, R * 0.14); // inner lip next to the art
  const ring = (inset: number) =>
    `M 0 0 H ${S} V ${S} H 0 Z M ${f(inset)} ${f(inset)} H ${f(S - inset)} V ${f(S - inset)} H ${f(inset)} Z`;

  // Rosettes at the four corners of the rail and beads along each rail.
  const c = R / 2;
  const corners = [
    [c, c],
    [S - c, c],
    [c, S - c],
    [S - c, S - c],
  ] as const;
  const rosette = ([cx, cy]: readonly [number, number]) =>
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 0.3)}" fill="url(#rosette)" stroke="#6b4b0b" stroke-width="${f(R * 0.03)}"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 0.12)}" fill="#3a2705"/>`;
  const beads: string[] = [];
  const step = R * 0.9;
  for (let x = R + step; x < S - R; x += step) {
    beads.push(`<circle cx="${f(x)}" cy="${f(c)}" r="${f(R * 0.08)}" fill="#3a2705" opacity="0.55"/>`);
    if (x < p.x - R * 0.4 || x > p.x + p.width + R * 0.4) beads.push(`<circle cx="${f(x)}" cy="${f(S - c)}" r="${f(R * 0.08)}" fill="#3a2705" opacity="0.55"/>`);
  }
  for (let y = R + step; y < S - R; y += step) {
    beads.push(`<circle cx="${f(c)}" cy="${f(y)}" r="${f(R * 0.08)}" fill="#3a2705" opacity="0.55"/>`);
    beads.push(`<circle cx="${f(S - c)}" cy="${f(y)}" r="${f(R * 0.08)}" fill="#3a2705" opacity="0.55"/>`);
  }

  // Placard lettering: centred on the plate, engraved (dark) with a light highlight offset below-right.
  const em = p.height * 0.52;
  const scale = em / 100;
  const tw = textWidth(placardText) * scale;
  const tx = p.x + (p.width - tw) / 2;
  const ty = p.y + (p.height - em) / 2;
  const strokeAttrs = (color: string, width: number) => `fill="none" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round"`;
  const hl = textPaths(placardText, tx + em * 0.035, ty + em * 0.035, em, strokeAttrs('#ffe9a8', GLYPH_STROKE));
  const ink = textPaths(placardText, tx, ty, em, strokeAttrs('#2a1c05', GLYPH_STROKE));
  const rx = p.height * 0.18;
  const screwR = p.height * 0.075;
  const screws = [
    [p.x + p.height * 0.32, p.y + p.height / 2],
    [p.x + p.width - p.height * 0.32, p.y + p.height / 2],
  ] as const;
  const screw = ([cx, cy]: readonly [number, number]) =>
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(screwR)}" fill="url(#screw)" stroke="#3a2705" stroke-width="${f(screwR * 0.25)}"/>` +
    `<path d="M ${f(cx - screwR * 0.6)} ${f(cy - screwR * 0.6)} L ${f(cx + screwR * 0.6)} ${f(cy + screwR * 0.6)}" stroke="#3a2705" stroke-width="${f(screwR * 0.3)}" stroke-linecap="round"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<defs>` +
    `<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#f3d777"/><stop offset="0.35" stop-color="#c9a227"/><stop offset="0.6" stop-color="#e8c65a"/><stop offset="1" stop-color="#9b7413"/>` +
    `</linearGradient>` +
    `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#d9b544"/><stop offset="0.5" stop-color="#b8902a"/><stop offset="1" stop-color="#8a6710"/>` +
    `</linearGradient>` +
    `<radialGradient id="rosette" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#a67c12"/></radialGradient>` +
    `<radialGradient id="screw" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#fff3c4"/><stop offset="1" stop-color="#b08a20"/></radialGradient>` +
    `<pattern id="weave" width="${f(R * 0.5)}" height="${f(R * 0.5)}" patternUnits="userSpaceOnUse">` +
    `<path d="M 0 ${f(R * 0.25)} L ${f(R * 0.25)} 0 L ${f(R * 0.5)} ${f(R * 0.25)} L ${f(R * 0.25)} ${f(R * 0.5)} Z" fill="#000" opacity="0.07"/>` +
    `</pattern>` +
    `</defs>` +
    // Rail: gold ring, subtle weave, outer bevel, inner lip and a shadow onto the art.
    `<path d="${ring(R)}" fill="url(#gold)" fill-rule="evenodd"/>` +
    `<path d="${ring(R)}" fill="url(#weave)" fill-rule="evenodd"/>` +
    `<path d="${ring(edge)}" fill="#5a3f08" fill-rule="evenodd"/>` +
    `<path d="M ${f(R - lip)} ${f(R - lip)} H ${f(S - R + lip)} V ${f(S - R + lip)} H ${f(R - lip)} Z M ${f(R)} ${f(R)} H ${f(S - R)} V ${f(S - R)} H ${f(R)} Z" fill="#4a3306" fill-rule="evenodd"/>` +
    `<rect x="${f(o.x)}" y="${f(o.y)}" width="${f(o.width)}" height="${f(o.height)}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="${f(lip)}" transform="translate(${f(lip / 2)} ${f(lip / 2)})"/>` +
    beads.join('') +
    corners.map(rosette).join('') +
    // Placard: drop shadow, plate, bevel, screws, lettering.
    `<rect x="${f(p.x + p.height * 0.06)}" y="${f(p.y + p.height * 0.08)}" width="${f(p.width)}" height="${f(p.height)}" rx="${f(rx)}" fill="#000" opacity="0.4"/>` +
    `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.width)}" height="${f(p.height)}" rx="${f(rx)}" fill="url(#plate)" stroke="#3a2705" stroke-width="${f(p.height * 0.04)}"/>` +
    `<rect x="${f(p.x + p.height * 0.09)}" y="${f(p.y + p.height * 0.09)}" width="${f(p.width - p.height * 0.18)}" height="${f(p.height - p.height * 0.18)}" rx="${f(rx * 0.6)}" fill="none" stroke="#ffe9a8" stroke-opacity="0.55" stroke-width="${f(p.height * 0.03)}"/>` +
    screws.map(screw).join('') +
    hl +
    ink +
    `</svg>`
  );
}

export { GLYPH_ADVANCE };
