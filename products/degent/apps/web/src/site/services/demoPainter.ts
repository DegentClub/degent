/**
 * Demo-only compositor (browser canvas): paints the placeholder gentleman (or the uploaded image),
 * draws a gold frame with the placard, encodes a real JPEG, then pads it with JPEG comment segments
 * to land inside the tier. The real Atelier composes server-side with libvips (see
 * services/atelier/README.md); this exists so `?demo=1` works with no server and no network.
 */
import { gentlemanDataUrl } from '../lib/art';
import { padJpeg, syntheticJpeg } from '../lib/jpeg';
import type { RenderArgs } from './fakes';

async function loadImage(src: Blob | string): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof src !== 'string' && typeof createImageBitmap === 'function') return createImageBitmap(src);
  const img = new Image();
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  img.src = url;
  try {
    await img.decode();
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url);
  }
  return img;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
}

export function drawFrame(ctx: CanvasRenderingContext2D, edge: number, placard: string | null): void {
  const rail = Math.round(edge * 0.075);
  const g = ctx.createLinearGradient(0, 0, edge, edge);
  g.addColorStop(0, '#f6d77a');
  g.addColorStop(0.35, '#b98a2e');
  g.addColorStop(0.6, '#f1cf6c');
  g.addColorStop(1, '#8a6420');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, edge, rail);
  ctx.fillRect(0, edge - rail, edge, rail);
  ctx.fillRect(0, 0, rail, edge);
  ctx.fillRect(edge - rail, 0, rail, edge);
  ctx.strokeStyle = '#5a3f10';
  ctx.lineWidth = Math.max(2, edge * 0.004);
  ctx.strokeRect(rail, rail, edge - 2 * rail, edge - 2 * rail);
  ctx.strokeStyle = '#fff3c4';
  ctx.strokeRect(rail * 0.35, rail * 0.35, edge - rail * 0.7, edge - rail * 0.7);
  if (!placard) return;
  const pw = edge * 0.3;
  const ph = edge * 0.075;
  const px = (edge - pw) / 2;
  const py = edge - rail - ph * 1.25;
  ctx.fillStyle = g;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = '#5a3f10';
  ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle = '#2a1d05';
  ctx.font = `700 ${Math.round(ph * 0.58)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(placard, edge / 2, py + ph / 2 + 1);
}

export async function paintDemoDegent(a: RenderArgs): Promise<Uint8Array> {
  const edge = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext('2d');
  if (!ctx) return syntheticJpeg(edge, edge, a.targetBytes);
  const src = await loadImage(a.source ?? gentlemanDataUrl(a.seed));
  const inset = a.frame ? Math.round(edge * 0.075) : 0;
  const box = edge - 2 * inset;
  const s = Math.min(src.width, src.height);
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, edge, edge);
  ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, inset, inset, box, box);
  if (a.frame) drawFrame(ctx, edge, a.placard);
  let quality = 0.95;
  let bytes = new Uint8Array(await (await toBlob(canvas, quality)).arrayBuffer());
  while (bytes.length > a.targetBytes - 64 && quality > 0.3) {
    quality -= 0.1;
    bytes = new Uint8Array(await (await toBlob(canvas, quality)).arrayBuffer());
  }
  return padJpeg(bytes, a.targetBytes) ?? bytes;
}
