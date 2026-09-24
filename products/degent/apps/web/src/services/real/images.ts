/** Real ImageTools: browser decode + canvas re-encode + Atelier composition. Nothing leaves the browser. */
import type { EncodeType, EncodedImage, ImageTools, SourceImage, TemplateId } from '../types';
import { drawComposition } from '../../atelier/draw';

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(canvas: HTMLCanvasElement, type: EncodeType, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`This browser cannot encode ${type}.`))), type, quality),
  );
}

async function decodeToDrawable(blob: Blob): Promise<{ img: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    return { img: bmp, width: bmp.width, height: bmp.height };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createCanvasImages(): ImageTools {
  return {
    async decode(blob): Promise<SourceImage> {
      const d = await decodeToDrawable(blob);
      return { width: d.width, height: d.height, handle: d.img };
    },
    async encode(src, opts): Promise<EncodedImage> {
      const w = Math.max(1, Math.round(src.width * opts.scale));
      const h = Math.max(1, Math.round(src.height * opts.scale));
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
      if (opts.type === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'; // JPEG has no alpha
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src.handle as CanvasImageSource, 0, 0, w, h);
      const blob = await toBlob(canvas, opts.type, opts.quality);
      if (blob.type && blob.type !== opts.type) {
        throw new Error(`This browser produced ${blob.type} instead of ${opts.type}. Try JPEG.`);
      }
      return { blob, width: w, height: h };
    },
    async compose(src, layout) {
      const canvas = makeCanvas(layout.size, layout.size);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
      drawComposition(ctx, src.handle as CanvasImageSource, layout);
      return {
        width: canvas.width,
        height: canvas.height,
        toBlob: async (type, quality) => {
          const blob = await toBlob(canvas, type, quality);
          if (blob.type && blob.type !== type) throw new Error(`This browser produced ${blob.type} instead of ${type}.`);
          return blob;
        },
      };
    },
    async template(id) {
      const canvas = drawTemplate(id);
      return { width: canvas.width, height: canvas.height, handle: canvas };
    },
    async sample() {
      return drawSample();
    },
  };
}

/** Atelier backdrops: a lit room to put the gentleman in. Grain gives the encoder realistic entropy. */
function drawTemplate(id: TemplateId): HTMLCanvasElement {
  const size = 1600;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  const palettes: Record<TemplateId, [string, string, string]> = {
    lounge: ['#1f5c3f', '#0b2418', '#2efc86'],
    noir: ['#2a2f45', '#07080d', '#f7c948'],
    gala: ['#7a5a1c', '#1a1206', '#fbe7a1'],
  };
  const [inner, outer, accent] = palettes[id];
  const g = ctx.createRadialGradient(size / 2, size * 0.35, 60, size / 2, size / 2, size * 0.8);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  if (id === 'noir') {
    // skyline
    ctx.fillStyle = '#05060a';
    for (let x = 0, k = 0; x < size; x += 90, k++) {
      const h = 260 + ((k * 7919) % 11) * 45;
      ctx.fillRect(x, size - h, 80, h);
    }
  } else {
    // wainscoting
    ctx.strokeStyle = `${accent}33`;
    ctx.lineWidth = 6;
    for (let x = 80; x < size; x += 240) ctx.strokeRect(x, size * 0.62, 200, size * 0.3);
  }
  // spotlight where the gentleman stands
  const spot = ctx.createRadialGradient(size / 2, size * 0.55, 20, size / 2, size * 0.55, size * 0.4);
  spot.addColorStop(0, `${accent}40`);
  spot.addColorStop(1, 'transparent');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    img.data[i] = img.data[i]! + n;
    img.data[i + 1] = img.data[i + 1]! + n;
    img.data[i + 2] = img.data[i + 2]! + n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * A procedurally drawn placeholder "gentleman" for demo mode, so the whole flow can be tried
 * without art at hand. Includes noise so the encoder produces a realistic byte count.
 */
async function drawSample(): Promise<Blob> {
  const size = 1400;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  const g = ctx.createRadialGradient(size / 2, size / 3, 50, size / 2, size / 2, size);
  g.addColorStop(0, '#1d4a36');
  g.addColorStop(1, '#06120d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Grain, so the file has real entropy.
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 38;
    img.data[i] = img.data[i]! + n;
    img.data[i + 1] = img.data[i + 1]! + n;
    img.data[i + 2] = img.data[i + 2]! + n;
  }
  ctx.putImageData(img, 0, 0);
  // Head
  ctx.fillStyle = '#5c9a4a';
  ctx.beginPath();
  ctx.ellipse(700, 560, 330, 270, 0, 0, Math.PI * 2);
  ctx.fill();
  // Eyes
  for (const x of [560, 840]) {
    ctx.fillStyle = '#f4f1e4';
    ctx.beginPath();
    ctx.ellipse(x, 440, 110, 80, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(x + 20, 450, 38, 0, Math.PI * 2);
    ctx.fill();
  }
  // Mouth
  ctx.strokeStyle = '#7a2e22';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(700, 610, 190, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  // Tuxedo
  ctx.fillStyle = '#0b0b0d';
  ctx.beginPath();
  ctx.moveTo(250, 1400);
  ctx.lineTo(380, 860);
  ctx.lineTo(1020, 860);
  ctx.lineTo(1150, 1400);
  ctx.fill();
  ctx.fillStyle = '#f4f1e4';
  ctx.beginPath();
  ctx.moveTo(610, 860);
  ctx.lineTo(790, 860);
  ctx.lineTo(700, 1250);
  ctx.fill();
  // Bowtie (mandatory)
  ctx.fillStyle = '#c9a55a';
  ctx.beginPath();
  ctx.moveTo(700, 900);
  ctx.lineTo(590, 850);
  ctx.lineTo(590, 950);
  ctx.closePath();
  ctx.moveTo(700, 900);
  ctx.lineTo(810, 850);
  ctx.lineTo(810, 950);
  ctx.closePath();
  ctx.fill();
  // Text
  ctx.fillStyle = '#e3c27a';
  ctx.font = '600 120px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('DEGENT', 700, 200);
  return toBlob(c, 'image/png', 1);
}
