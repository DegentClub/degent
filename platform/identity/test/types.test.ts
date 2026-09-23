import { describe, expect, it } from 'vitest';
import { linkWallet, unlinkWallet, type BlockspaceIdentity } from '../src/index.js';

describe('BlockspaceIdentity linking', () => {
  const base: BlockspaceIdentity = { id: 'bsid_1', wallets: [] };
  it('links idempotently per address+network and unlinks', () => {
    const w = { address: 'bc1qa', network: 'mainnet' as const, verifiedAt: '2026-09-23T12:00:00.000Z' };
    let id = linkWallet(base, w);
    id = linkWallet(id, { ...w, verifiedAt: '2026-09-24T12:00:00.000Z' });
    id = linkWallet(id, { ...w, network: 'testnet' });
    expect(id.wallets).toHaveLength(2);
    expect(id.wallets.find((x) => x.network === 'mainnet')!.verifiedAt).toBe('2026-09-24T12:00:00.000Z');
    expect(unlinkWallet(id, 'bc1qa', 'mainnet').wallets).toHaveLength(1);
    expect(base.wallets).toHaveLength(0); // immutable
  });
});
