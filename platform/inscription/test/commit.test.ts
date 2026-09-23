import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { p2tr, TAPROOT_UNSPENDABLE_KEY, NETWORK as MAIN, TEST_NETWORK } from '@scure/btc-signer';
import { buildInscriptionScript, commitAddress, NUMS_INTERNAL_KEY, type Network } from '../src/index.js';
import { PARENT_INTERNAL, REVEAL_PUB } from './helpers.js';

const content = { contentType: 'text/plain;charset=utf-8', body: new TextEncoder().encode('Degent #1') };
const regtest = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

// Frozen vectors. They are cross-checked below against btc-signer's own p2tr() tree builder, so a
// change here means the envelope bytes changed (which changes every commit address).
const VECTORS: Record<Network, string> = {
  mainnet: 'bc1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruqxa5cuq',
  testnet: 'tb1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruq34zhx0',
  signet: 'tb1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruq34zhx0',
  regtest: 'bcrt1pv8dk4eanpvmxhmxrfsutnl9uv2epyexfnpuh78apmehyddud3ruquvg3n4',
};

describe('commitAddress', () => {
  it('uses the BIP341 NUMS point H as internal key', () => {
    expect(hex.encode(NUMS_INTERNAL_KEY)).toBe('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
    expect(NUMS_INTERNAL_KEY).toEqual(TAPROOT_UNSPENDABLE_KEY);
  });

  for (const [network, params, prefix] of [
    ['mainnet', MAIN, 'bc1p'],
    ['testnet', TEST_NETWORK, 'tb1p'],
    ['signet', TEST_NETWORK, 'tb1p'],
    ['regtest', regtest, 'bcrt1p'],
  ] as const) {
    it(`is deterministic on ${network} (${prefix}) and matches btc-signer p2tr`, () => {
      const c = commitAddress(REVEAL_PUB, content, network);
      expect(c.address.startsWith(prefix)).toBe(true);
      expect(c.address).toBe(VECTORS[network]);
      expect(commitAddress(REVEAL_PUB, content, network)).toEqual(c);
      const leaf = buildInscriptionScript(REVEAL_PUB, content);
      const ref = p2tr(TAPROOT_UNSPENDABLE_KEY, { script: leaf }, params, true);
      expect(c.address).toBe(ref.address);
      expect(c.script).toEqual(ref.script);
      expect(c.leafScript).toEqual(leaf);
      expect(c.controlBlock).toEqual((ref.leaves![0] as unknown as { controlBlock: Uint8Array }).controlBlock);
      expect(c.controlBlock.length).toBe(33);
      expect(c.tapLeafHash).toEqual(ref.leaves![0]!.hash);
      expect(c.script.length).toBe(34);
    });
  }

  it('changes when content, key or parent change', () => {
    const a = commitAddress(REVEAL_PUB, content, 'mainnet').address;
    expect(commitAddress(REVEAL_PUB, { ...content, contentType: 'text/html' }, 'mainnet').address).not.toBe(a);
    expect(commitAddress(REVEAL_PUB, { ...content, parentId: `${'00'.repeat(32)}i0` }, 'mainnet').address).not.toBe(a);
    expect(commitAddress(PARENT_INTERNAL, content, 'mainnet').address).not.toBe(a);
  });
});
