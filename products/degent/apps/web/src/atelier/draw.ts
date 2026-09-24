/**
 * Paints a CompositionLayout onto a 2D canvas: the cropped art, a bevelled gold frame (mitred rails lit from the
 * top left) and a brass placard with engraved capitals. Browser-only; the geometry is tested in composition.ts.
 */
import type { CompositionLayout } from './composition';

type Ctx = CanvasRenderingContext2D;

const GOLD = { hi: '#fbe7a1', mid: '#d4a94a', lo: '#8a6424', edge: '#4d3510' };

function rail(ctx: Ctx, pts: Array<[number, number]>, from: [number, number], to: [number, number], stops: string[]) {
  const g = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawComposition(ctx: Ctx, image: CanvasImageSource, l: CompositionLayout): void {
  const { size: s, frame: f } = l;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, s, s);
  ctx.drawImage(image, l.crop.sx, l.crop.sy, l.crop.sw, l.crop.sh, l.art.x, l.art.y, l.art.w, l.art.h);

  // Four mitred rails: light falls from the top left.
  const i = s - f;
  rail(ctx, [[0, 0], [s, 0], [i, f], [f, f]], [0, 0], [0, f], [GOLD.hi, GOLD.mid, GOLD.lo]);
  rail(ctx, [[0, 0], [f, f], [f, i], [0, s]], [0, 0], [f, 0], [GOLD.hi, GOLD.mid, GOLD.lo]);
  rail(ctx, [[s, 0], [s, s], [i, i], [i, f]], [s, 0], [i, 0], [GOLD.mid, GOLD.lo, GOLD.edge]);
  rail(ctx, [[0, s], [f, i], [i, i], [s, s]], [0, s], [0, i], [GOLD.mid, GOLD.lo, GOLD.edge]);
  // Beads: an outer lip, a mid-rail highlight and a dark sight edge against the art.
  const line = (inset: number, width: number, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.strokeRect(inset, inset, s - 2 * inset, s - 2 * inset);
  };
  line(Math.max(1, s * 0.002), Math.max(1, s * 0.003), GOLD.edge);
  line(f * 0.35, Math.max(1, f * 0.06), 'rgba(255, 244, 200, 0.55)');
  line(f * 0.72, Math.max(1, f * 0.04), 'rgba(77, 53, 16, 0.6)');
  line(f - Math.max(1, s * 0.002), Math.max(2, s * 0.004), '#241806');

  // Placard: brass plate, screw heads, engraved text.
  const p = l.placard;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = p.h * 0.25;
  ctx.shadowOffsetY = p.h * 0.08;
  const g = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
  g.addColorStop(0, '#f6dc8e');
  g.addColorStop(0.5, '#c9973c');
  g.addColorStop(1, '#9c7128');
  ctx.fillStyle = g;
  roundRect(ctx, p.x, p.y, p.w, p.h, p.h * 0.16);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = GOLD.edge;
  ctx.lineWidth = Math.max(1, p.h * 0.05);
  ctx.stroke();
  for (const x of [p.x + p.h * 0.32, p.x + p.w - p.h * 0.32]) {
    ctx.fillStyle = '#6b4c19';
    ctx.beginPath();
    ctx.arc(x, p.y + p.h / 2, p.h * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = `700 ${l.placardFontPx}px 'Space Grotesk', 'Helvetica Neue', Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${Math.round(l.placardFontPx * 0.12)}px`;
  ctx.fillStyle = 'rgba(255, 240, 190, 0.6)';
  ctx.fillText(l.text, s / 2, p.y + p.h / 2 + 1);
  ctx.fillStyle = '#2b1c05';
  ctx.fillText(l.text, s / 2, p.y + p.h / 2);
  ctx.restore();
}
