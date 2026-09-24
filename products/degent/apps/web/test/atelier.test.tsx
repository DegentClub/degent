/**
 * The Atelier: composition geometry, placard values, the size search on (mocked) canvas.toBlob, the Minting
 * Rules checklist, the reveal estimate against a real signed transaction, and the UI in the Create step.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildResignedRescue } from '@bsh/inscription';
import { DEFAULT_CONFIG, STANDARD_MAX_BYTES, STANDARD_MIN_BYTES } from '@bsh/degent-mint-sdk';
import {
  FRAME_MAX_PCT,
  FRAME_MIN_PCT,
  PLACARD_TEXTS,
  clampFramePct,
  isPlacardText,
  layoutComposition,
  squareCrop,
} from '../src/atelier/composition';
import { clampTarget, searchJpegSize } from '../src/atelier/sizeSearch';
import { mintingRules } from '../src/atelier/mintingRules';
import { estimateReveal } from '../src/lib/revealEstimate';
import { flowReducer } from '../src/flow/reducer';
import { initialState } from '../src/flow/state';
import { fakes, renderApp, testApp } from './helpers';

describe('composition geometry', () => {
  it('crops the largest centred square, then zooms and pans inside the free space', () => {
    expect(squareCrop(1600, 1000)).toEqual({ sx: 300, sy: 0, side: 1000 });
    expect(squareCrop(1000, 1600)).toEqual({ sx: 0, sy: 300, side: 1000 });
    expect(squareCrop(1600, 1000, { zoom: 2, panX: 0, panY: 0 })).toEqual({ sx: 550, sy: 250, side: 500 });
    expect(squareCrop(1600, 1000, { zoom: 1, panX: -1, panY: 0 }).sx).toBe(0);
    expect(squareCrop(1600, 1000, { zoom: 1, panX: 1, panY: 0 }).sx).toBe(600);
    // out-of-range inputs are clamped, never produce a non-square or out-of-bounds crop
    const wild = squareCrop(800, 600, { zoom: 99, panX: 7, panY: -7 });
    expect(wild.side).toBe(150);
    expect(wild.sx + wild.side).toBeLessThanOrEqual(800);
    expect(wild.sy).toBe(0);
  });

  it('lays out a square output with the frame at 5–25 % of the edge and the placard on the bottom rail', () => {
    const l = layoutComposition(1600, 1000, { size: 1200, framePct: 12, placard: 'DEGEN', crop: { zoom: 1, panX: 0, panY: 0 } });
    expect(l.size).toBe(1200);
    expect(l.crop).toEqual({ sx: 300, sy: 0, sw: 1000, sh: 1000 });
    expect(l.frame).toBe(144);
    expect(l.art).toEqual({ x: 144, y: 144, w: 912, h: 912 });
    expect(l.art.w).toBe(l.art.h); // square art inside a square frame
    // placard: centred, on the bottom rail, inside the canvas
    expect(l.placard.x * 2 + l.placard.w).toBe(1200);
    expect(l.placard.y + l.placard.h).toBeLessThanOrEqual(1200);
    expect(l.placard.y + l.placard.h / 2).toBeCloseTo(1200 - 144 / 2, 0);
    expect(l.placardFontPx).toBeGreaterThan(0);
    expect(l.text).toBe('DEGEN');

    expect(clampFramePct(1)).toBe(FRAME_MIN_PCT);
    expect(clampFramePct(40)).toBe(FRAME_MAX_PCT);
    expect(layoutComposition(1000, 1000, { size: 1000, framePct: 3, placard: 'REGEN', crop: { zoom: 1, panX: 0, panY: 0 } }).frame).toBe(50);
    expect(layoutComposition(1000, 1000, { size: 1000, framePct: 60, placard: 'REGEN', crop: { zoom: 1, panX: 0, panY: 0 } }).frame).toBe(250);
    // thin frame: the plate overlaps the art a little but never leaves the canvas
    const thin = layoutComposition(1000, 1000, { size: 2000, framePct: 5, placard: 'DEGENT', crop: { zoom: 1, panX: 0, panY: 0 } });
    expect(thin.placard.y + thin.placard.h).toBeLessThanOrEqual(2000);
  });

  it('allows exactly DEGEN, DEGENT and REGEN on the placard (mint rule 3)', () => {
    expect([...PLACARD_TEXTS]).toEqual(['DEGEN', 'DEGENT', 'REGEN']);
    for (const t of PLACARD_TEXTS) expect(isPlacardText(t)).toBe(true);
    for (const t of ['degen', 'DEGENTS', 'DEGEN ', 'GENT', '', null, 42]) expect(isPlacardText(t)).toBe(false);
    expect(() => layoutComposition(1000, 1000, { size: 1000, framePct: 10, placard: 'HELLO' as never, crop: { zoom: 1, panX: 0, panY: 0 } })).toThrow(/DEGEN, DEGENT, REGEN/);
  });
});

/** A canvas whose toBlob returns `bytesAt(quality)` bytes: what a JPEG encoder does, monotonic in quality. */
function mockCanvas(bytesAt: (q: number) => number) {
  const toBlob = vi.fn((cb: (b: Blob | null) => void, _type: string, q: number) => cb(new Blob([new Uint8Array(Math.round(bytesAt(q)))], { type: 'image/jpeg' })));
  const encode = (q: number) => new Promise<Blob>((resolve) => toBlob((b) => resolve(b!), 'image/jpeg', q));
  return { toBlob, encode };
}

describe('size search on real toBlob bytes', () => {
  const bounds = { minBytes: STANDARD_MIN_BYTES, maxBytes: STANDARD_MAX_BYTES };

  it('converges to the largest file not above the target, inside the tier bounds', async () => {
    for (const targetBytes of [205_000, 260_000, 300_000, 385_000]) {
      const c = mockCanvas((q) => 40_000 + 720_000 * q ** 1.6);
      const r = await searchJpegSize(c.encode, { ...bounds, targetBytes });
      expect(r.status, String(targetBytes)).toBe('fit');
      expect(r.size).toBeLessThanOrEqual(targetBytes);
      expect(r.size).toBeGreaterThanOrEqual(STANDARD_MIN_BYTES);
      expect(r.size).toBeGreaterThanOrEqual(targetBytes * 0.97);
      expect(r.size).toBe(r.blob.size); // measured, not estimated
      expect(c.toBlob.mock.calls.length).toBe(r.attempts.length);
      expect(r.attempts.length).toBeLessThanOrEqual(12);
    }
  });

  it('clamps the target into the tier and reports designs that cannot fit', async () => {
    expect(clampTarget({ ...bounds, targetBytes: 10 })).toBe(STANDARD_MIN_BYTES);
    expect(clampTarget({ ...bounds, targetBytes: 9e9 })).toBe(STANDARD_MAX_BYTES);
    const tiny = await searchJpegSize(mockCanvas((q) => 20_000 + 100_000 * q).encode, { ...bounds, targetBytes: 300_000 });
    expect(tiny.status).toBe('too-small');
    expect(tiny.attempts).toHaveLength(1);
    const huge = await searchJpegSize(mockCanvas((q) => 500_000 + 2_000_000 * q).encode, { ...bounds, targetBytes: 300_000 });
    expect(huge.status).toBe('too-large');
    // a cliff: every quality is either below the minimum or above the maximum
    const cliff = await searchJpegSize(mockCanvas((q) => (q < 0.5 ? 150_000 : 450_000)).encode, { ...bounds, targetBytes: 300_000 });
    expect(cliff.status).toBe('no-fit');
    await expect(searchJpegSize(mockCanvas(() => 1).encode, { minBytes: 10, maxBytes: 5, targetBytes: 7 })).rejects.toThrow(/bounds/);
  });
});

describe('Minting Rules checklist', () => {
  const base = { tier: 'standard' as const, config: DEFAULT_CONFIG, briefAck: {} as Record<string, boolean> };
  const art = { contentType: 'image/jpeg', width: 1200, height: 1200, size: 300_000 };
  const state = (rules: ReturnType<typeof mintingRules>) => Object.fromEntries(rules.map((r) => [r.id, r.satisfied]));

  it('nothing on the table: only Quantity holds', () => {
    expect(state(mintingRules({ ...base, artwork: null, framing: null }))).toEqual({ format: false, design: false, framing: false, quantity: true });
  });

  it('an Atelier JPEG with the brief confirmed satisfies all four', () => {
    const rules = mintingRules({ ...base, artwork: art, framing: { framePct: 12, placard: 'DEGENT' }, briefAck: { 'pepe-tuxedo': true, bowtie: true } });
    expect(state(rules)).toEqual({ format: true, design: true, framing: true, quantity: true });
    expect(rules.map((r) => r.title)).toEqual(['File Format & Size', 'Essential Design', 'Framing & Text', 'Quantity']);
    expect(rules.find((r) => r.id === 'framing')!.how).toBe('measured');
    expect(rules.find((r) => r.id === 'design')!.how).toBe('you confirm');
  });

  it('format fails for non-square, undersized, oversized-for-tier or a disallowed type; WebP is accepted', () => {
    const f = (a: typeof art) => mintingRules({ ...base, artwork: a, framing: null }).find((r) => r.id === 'format')!;
    expect(f({ ...art, width: 1200, height: 900 }).satisfied).toBe(false);
    expect(f({ ...art, size: 150_000 }).satisfied).toBe(false);
    expect(f({ ...art, size: 500_000 }).satisfied).toBe(false); // block-sized in the standard tier
    expect(f({ ...art, contentType: 'image/bmp' }).satisfied).toBe(false);
    const webp = f({ ...art, contentType: 'image/webp' });
    expect(webp.satisfied).toBe(true);
    expect(webp.detail).toMatch(/JPEG recommended/);
  });

  it('framing without the Atelier needs the brief; a bad placard fails', () => {
    const fr = (framing: { framePct: number; placard: string } | null, briefAck = {}) =>
      mintingRules({ ...base, artwork: art, framing, briefAck }).find((r) => r.id === 'framing')!.satisfied;
    expect(fr(null)).toBe(false);
    expect(fr(null, { text: true })).toBe(true);
    expect(fr({ framePct: 12, placard: 'HELLO' })).toBe(false);
    expect(fr({ framePct: 30, placard: 'DEGEN' })).toBe(false);
  });
});

describe('reveal estimate (@bsh/inscription)', () => {
  it('matches the weight of a real signed parent-less reveal (rescue is exactly 1 WU lighter)', () => {
    const priv = new Uint8Array(32).fill(3);
    const recipient = btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(4))).address!;
    for (const len of [200_000, 311_111, 389_999]) {
      const body = new Uint8Array(len).fill(7);
      const real = buildResignedRescue({
        network: 'mainnet',
        revealPrivkey: priv,
        content: { contentType: 'image/jpeg', body },
        commitOutpoint: { txid: 'ab'.repeat(32), vout: 0 },
        commitValue: 2_000_000n,
        recipientAddress: recipient,
        postage: 546n,
      });
      const tx = btc.Transaction.fromRaw(hex.decode(real.hex), { allowUnknownOutputs: true });
      const est = estimateReveal({ contentType: 'image/jpeg', bodyLength: len, parentId: null, network: 'mainnet', recipientAddress: recipient, feeRate: 3, postageSats: 546 });
      expect(est.weight).toBe(tx.weight + 1);
      expect(est.vsize).toBe(Math.ceil(est.weight / 4));
      expect(est.feeSats).toBe(est.vsize * 3);
      expect(est.commitValueSats).toBe(est.feeSats + 546);
      expect(est.lane).toBe('standard');
    }
    // the parent adds an input and an output
    const withParent = estimateReveal({ contentType: 'image/jpeg', bodyLength: 300_000, parentId: `${'a'.repeat(64)}i0`, network: 'mainnet', feeRate: 1, postageSats: 546 });
    const without = estimateReveal({ contentType: 'image/jpeg', bodyLength: 300_000, parentId: null, network: 'mainnet', feeRate: 1, postageSats: 546 });
    expect(withParent.weight).toBeGreaterThan(without.weight);
  });
});

describe('the Atelier in the Create step', () => {
  async function atCreate() {
    const services = fakes();
    const config = await services.mintApi.getConfig();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    let s = flowReducer(initialState(), { type: 'CONFIG_LOADED', config });
    s = flowReducer(s, { type: 'SNAPSHOT_LOADED', fees: await services.mintApi.getFees(), queue: null });
    s = { ...flowReducer(s, { type: 'WALLET_CONNECTED', wallet }), step: 'create' };
    return { services, ...renderApp(services, { initial: s, app: testApp(), path: '/mint' }) };
  }

  it('template → frame → placard → size fit → readout and rules → Use this design', async () => {
    const user = userEvent.setup();
    const { services } = await atCreate();
    expect(screen.getByRole('radio', { name: 'The Atelier: frame it here' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Green lounge' }));
    const readout = await screen.findByTestId('atelier-readout', {}, { timeout: 3000 });
    expect(within(readout).getByText(/^[\d,]+ vB$/)).toBeInTheDocument();
    expect(within(readout).getByText(/WU, exact/)).toBeInTheDocument();
    expect(within(readout).getByText(/^[\d,]+ sats$/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Atelier preview: the exact JPEG, framed, placard DEGENT/ })).toBeInTheDocument();
    expect(services.log).toContain('images.compose');

    const rules = screen.getByTestId('minting-rules');
    await waitFor(() => expect(within(rules).getByTestId('rule-format')).toHaveAttribute('data-satisfied', 'true'));
    expect(within(rules).getByTestId('rule-framing')).toHaveAttribute('data-satisfied', 'true');
    expect(within(rules).getByTestId('rule-design')).toHaveAttribute('data-satisfied', 'false');
    expect(within(rules).getByTestId('rule-quantity')).toHaveAttribute('data-satisfied', 'true');

    await user.click(screen.getByRole('radio', { name: 'REGEN' }));
    await user.click(screen.getByRole('checkbox', { name: /Pepe, in a tuxedo/ }));
    await user.click(screen.getByRole('checkbox', { name: /Bowtie/ }));
    await waitFor(() => expect(within(rules).getByTestId('rule-design')).toHaveAttribute('data-satisfied', 'true'));
    await waitFor(() => expect(screen.getByRole('img', { name: /placard REGEN/ })).toBeInTheDocument());
    const use = screen.getByRole('button', { name: 'Use this design' });
    await waitFor(() => expect(use).toBeEnabled());
    await user.click(use);

    expect(await screen.findByText('Fits Standard Degent')).toBeInTheDocument();
    expect(screen.getByText(/Composed in the Atelier: square, gold frame 12%, placard “REGEN”/)).toBeInTheDocument();
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    // The placard satisfies the brief's text line.
    expect(screen.getByRole('checkbox', { name: /The word “DEGEN”/ })).toBeChecked();
  });

  it('the frame slider stays within 5–25 % and the target slider within the tier bounds', async () => {
    await atCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Noir city' }));
    const frame = await screen.findByLabelText(/Frame width/);
    expect(frame).toHaveAttribute('min', '5');
    expect(frame).toHaveAttribute('max', '25');
    const target = screen.getByLabelText(/Target file size/);
    expect(target).toHaveAttribute('min', '200000');
    expect(target).toHaveAttribute('max', '390000');
  });
});
