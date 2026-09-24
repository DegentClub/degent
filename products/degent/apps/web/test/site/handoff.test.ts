import { describe, expect, it } from 'vitest';
import { flowReducer } from '../../src/flow/reducer';
import { initialState, type FlowState } from '../../src/flow/state';
import { demoConfig, createFakeWallets } from '../../src/services/fakes';
import { measureBytes, verifyContent } from '../../src/site/lib/handoff';
import { syntheticJpeg } from '../../src/site/lib/jpeg';
import { readImageInfo } from '@bsh/degent-mint-sdk';

const bytes = syntheticJpeg(1024, 1024, 300_000);
const { artwork, tier } = measureBytes(bytes, 'a.jpg');
const handoff = { type: 'HANDOFF' as const, artwork, tier: tier!, handoff: { source: 'atelier' as const, label: 'x' } };

describe('HANDOFF (Atelier / upload → mint)', () => {
  it('measures the exact bytes: same object, sha, dims, tier', () => {
    expect(artwork.bytes).toBe(bytes);
    expect(artwork).toMatchObject({ contentType: 'image/jpeg', width: 1024, height: 1024, size: 300_000, origin: 'original' });
    expect(tier).toBe('standard');
    expect(() => verifyContent(bytes, '0'.repeat(64), 'a.jpg')).toThrow(/does not match/);
  });

  it('before config: waits on Welcome, then goes to Connect when the config arrives', () => {
    let s = flowReducer(initialState(), handoff);
    expect(s.step).toBe('welcome');
    expect(s.artwork?.bytes).toBe(bytes);
    s = flowReducer(s, { type: 'CONFIG_LOADED', config: demoConfig('mainnet') });
    expect(s.step).toBe('connect');
  });

  it('with config and wallet: lands on Validate directly (Create skipped)', async () => {
    let s: FlowState = flowReducer(initialState(), { type: 'CONFIG_LOADED', config: demoConfig('mainnet') });
    const wallet = await createFakeWallets().connect('unisat', 'mainnet');
    s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
    s = flowReducer(s, handoff);
    expect(s.step).toBe('validate');
    expect(s.tier).toBe('standard');
    expect(s.handoff).toEqual({ source: 'atelier', label: 'x' });
  });

  it('is refused once money may have moved', () => {
    const s: FlowState = { ...initialState(), config: demoConfig('mainnet'), step: 'pay', pay: { ...initialState().pay, phase: 'awaiting-wallet' } };
    expect(flowReducer(s, handoff)).toBe(s);
  });

  it('choosing art in Create clears the handoff', () => {
    let s = flowReducer({ ...initialState(), config: demoConfig('mainnet') }, handoff);
    s = flowReducer(s, { type: 'ARTWORK_READY', artwork });
    expect(s.handoff).toBeNull();
  });
});

describe('padJpeg / syntheticJpeg', () => {
  it('produces exact sizes that still parse', () => {
    for (const size of [200_000, 400_000, 1_234_567, 3_600_000]) {
      const b = syntheticJpeg(2048, 2048, size);
      expect(b.length).toBe(size);
      expect(readImageInfo(b)).toEqual({ contentType: 'image/jpeg', width: 2048, height: 2048 });
    }
  });
});
