/**
 * Deterministic placeholder provider for tests and demo mode. Draws a Pepe-ish gentleman (green
 * frog head, tuxedo, bow tie) as SVG and rasterises it with sharp. The seed (explicit, or derived
 * from the prompt) picks the palette and a few shape parameters, so variations differ but the
 * same request always yields the same bytes.
 */
import sharp from 'sharp';
import { sha256 } from '@noble/hashes/sha2.js';
import type { GenerateRequest, GeneratedImage, ImageProvider } from './image-provider.js';

function seedFromPrompt(prompt: string): number {
  const h = sha256(new TextEncoder().encode(prompt));
  return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
}

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

export function fakePepeSvg(seed: number, size = 1024): string {
  const r = rng(seed);
  const bgHue = r() * 360;
  const bg1 = hsl(bgHue, 45, 22);
  const bg2 = hsl((bgHue + 40) % 360, 55, 42);
  const skin = hsl(100 + r() * 25, 45 + r() * 15, 38 + r() * 8);
  const skinDark = hsl(105, 45, 28);
  const tux = r() > 0.8 ? '#1b1b2f' : '#111';
  const tie = hsl(r() * 360, 70, 45);
  const S = size;
  const u = S / 1024;
  const dots: string[] = [];
  const n = 40 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const cx = r() * S;
    const cy = r() * S * 0.7;
    const rad = (4 + r() * 18) * u;
    dots.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="#fff" opacity="${(0.05 + r() * 0.2).toFixed(2)}"/>`);
  }
  const eyeTilt = (r() - 0.5) * 10;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 1024 1024">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>` +
    `<radialGradient id="sk" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="${skin}"/><stop offset="1" stop-color="${skinDark}"/></radialGradient></defs>` +
    `<rect width="1024" height="1024" fill="url(#bg)"/>` +
    `<g transform="scale(${(1 / u).toFixed(5)})">${dots.join('')}</g>` +
    // tuxedo body
    `<path d="M 200 1024 C 200 780 320 700 512 690 C 704 700 824 780 824 1024 Z" fill="${tux}"/>` +
    `<path d="M 430 700 L 512 900 L 594 700 Z" fill="#f4f1e6"/>` +
    `<path d="M 430 700 L 470 830 L 512 760 Z M 594 700 L 554 830 L 512 760 Z" fill="#2a2a2a"/>` +
    // bow tie
    `<path d="M 512 735 L 440 700 L 440 770 Z M 512 735 L 584 700 L 584 770 Z" fill="${tie}" stroke="#111" stroke-width="6"/>` +
    `<circle cx="512" cy="735" r="16" fill="${tie}" stroke="#111" stroke-width="6"/>` +
    // head
    `<ellipse cx="512" cy="470" rx="250" ry="230" fill="url(#sk)"/>` +
    `<ellipse cx="512" cy="560" rx="190" ry="110" fill="${skin}" opacity="0.9"/>` +
    // eyes
    `<g transform="rotate(${eyeTilt.toFixed(1)} 512 380)">` +
    `<ellipse cx="410" cy="380" rx="78" ry="58" fill="#f6f3e8" stroke="#1c2a12" stroke-width="10"/>` +
    `<ellipse cx="614" cy="380" rx="78" ry="58" fill="#f6f3e8" stroke="#1c2a12" stroke-width="10"/>` +
    `<circle cx="430" cy="388" r="26" fill="#111"/><circle cx="634" cy="388" r="26" fill="#111"/>` +
    `<path d="M 330 340 Q 410 300 490 335" stroke="#1c2a12" stroke-width="16" fill="none" stroke-linecap="round"/>` +
    `<path d="M 534 335 Q 614 300 694 340" stroke="#1c2a12" stroke-width="16" fill="none" stroke-linecap="round"/>` +
    `</g>` +
    // mouth
    `<path d="M 360 560 Q 512 640 664 560" stroke="#1c2a12" stroke-width="14" fill="none" stroke-linecap="round"/>` +
    `<path d="M 380 600 Q 512 620 644 600" stroke="#1c2a12" stroke-width="8" fill="none" opacity="0.6" stroke-linecap="round"/>` +
    `</svg>`
  );
}

export class FakeImageProvider implements ImageProvider {
  readonly name = 'fake';
  constructor(private readonly opts: { costCents?: number; size?: number; failWith?: string } = {}) {}

  estimateCostCents(req: Pick<GenerateRequest, 'n' | 'size'>): number {
    return (this.opts.costCents ?? 0) * req.n;
  }

  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    if (this.opts.failWith) throw new Error(this.opts.failWith);
    const base = req.seed ?? seedFromPrompt(req.prompt);
    const out: GeneratedImage[] = [];
    for (let i = 0; i < req.n; i++) {
      const seed = (base + i * 0x9e3779b1) >>> 0;
      const svg = fakePepeSvg(seed, this.opts.size ?? 1024);
      const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
      out.push({ bytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), mime: 'image/png', providerRef: `fake:${seed.toString(16)}` });
    }
    return out;
  }
}
