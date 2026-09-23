import { describe, expect, it } from 'vitest';
import { UnsupportedNetworkError, UserRejectedError, WalletNotInstalledError, xverseAdapter } from '../src/index.js';
import { ADDR, PUBKEY_A, PUBKEY_B, SIGNED_B64, UNSIGNED_B64, win } from './helpers.js';
import { fakeRpcProvider, rpcError, type Handler } from './sats-fake.js';

const MAIN_ADDRS = [
  { address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' },
  { address: ADDR.main.p2sh, publicKey: PUBKEY_B, purpose: 'payment', addressType: 'p2sh' },
];
const TEST_ADDRS = [
  { address: ADDR.test.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals' },
  { address: ADDR.test.p2wpkh, publicKey: PUBKEY_B, purpose: 'payment' },
];

function install(handlers: Record<string, Handler> = {}, envelope = true) {
  const f = fakeRpcProvider(
    {
      wallet_connect: (p) => ({
        id: 'acct',
        addresses: (p as { network: string }).network === 'Mainnet' ? MAIN_ADDRS : TEST_ADDRS,
        walletType: 'software',
        network: { bitcoin: { name: (p as { network: string }).network } },
      }),
      signPsbt: () => ({ psbt: SIGNED_B64 }),
      signMessage: () => ({ signature: 'xv-sig', messageHash: 'h', address: 'a', protocol: 'BIP322' }),
      wallet_disconnect: () => null,
      ...handlers,
    },
    envelope,
  );
  win().XverseProviders = { BitcoinProvider: f.p };
  return f;
}

describe('Xverse adapter', () => {
  it('not installed', async () => {
    expect(xverseAdapter.isInstalled()).toBe(false);
    await expect(xverseAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
    win().XverseProviders = {};
    expect(xverseAdapter.isInstalled()).toBe(false);
  });

  it('connect via wallet_connect maps ordinals + payment purposes', async () => {
    const { rec } = install();
    expect(xverseAdapter.isInstalled()).toBe(true);
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(rec.calls[0]).toEqual({
      method: 'wallet_connect',
      args: [{ addresses: ['ordinals', 'payment'], message: 'Connect your wallet', network: 'Mainnet' }],
    });
    expect(w.ordinals).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' });
    expect(w.payment).toEqual({ address: ADDR.main.p2sh, publicKey: PUBKEY_B, purpose: 'payment', addressType: 'p2sh-p2wpkh' });
  });

  it.each([
    ['testnet', 'Testnet4'],
    ['signet', 'Signet'],
  ] as const)('network %s → %s', async (network, name) => {
    const { rec } = install();
    const w = await xverseAdapter.connect({ network });
    expect((rec.calls[0]!.args[0] as { network: string }).network).toBe(name);
    expect(w.network).toBe(network);
  });

  it('wallet reporting another network → UnsupportedNetworkError', async () => {
    install({ wallet_connect: () => ({ addresses: MAIN_ADDRS, network: { bitcoin: { name: 'Mainnet' } } }) });
    await expect(xverseAdapter.connect({ network: 'signet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('addresses on the wrong network → UnsupportedNetworkError even without a network report', async () => {
    install({ wallet_connect: () => ({ addresses: MAIN_ADDRS }) });
    await expect(xverseAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('falls back to getAccounts when wallet_connect is not found', async () => {
    const { rec, handlers } = install({ getAccounts: () => MAIN_ADDRS });
    delete handlers.wallet_connect;
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(rec.methods()).toEqual(['wallet_connect', 'getAccounts']);
    expect(rec.last('getAccounts')?.args[0]).toEqual({ purposes: ['ordinals', 'payment'], message: 'Connect your wallet' });
    expect(w.ordinals.address).toBe(ADDR.main.p2tr);
  });

  it('falls back to getAddresses (legacy Skrybit call) with network.type', async () => {
    const { rec, handlers } = install({ getAddresses: () => ({ addresses: TEST_ADDRS }) });
    delete handlers.wallet_connect;
    const w = await xverseAdapter.connect({ network: 'testnet' });
    expect(rec.methods()).toEqual(['wallet_connect', 'getAccounts', 'getAddresses']);
    expect(rec.last('getAddresses')?.args[0]).toEqual({
      purposes: ['ordinals', 'payment'],
      message: 'Connect your wallet',
      network: { type: 'Testnet4' },
    });
    expect(w.payment.address).toBe(ADDR.test.p2wpkh);
  });

  it('no connect method at all → UNSUPPORTED_METHOD', async () => {
    const { handlers } = install();
    delete handlers.wallet_connect;
    await expect(xverseAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
  });

  it('user rejection (-32000 envelope) → UserRejectedError, no fallback attempted', async () => {
    const { rec } = install({ wallet_connect: () => rpcError(-32000, 'User rejected request') });
    await expect(xverseAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    expect(rec.methods()).toEqual(['wallet_connect']);
  });

  it('user rejection thrown by a rejecting provider → UserRejectedError', async () => {
    install({
      wallet_connect: () => {
        throw { jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'rejected' } };
      },
    });
    await expect(xverseAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('missing a purpose → NOT_CONNECTED', async () => {
    install({ wallet_connect: () => ({ addresses: [MAIN_ADDRS[0]] }) });
    await expect(xverseAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('works with a provider that returns bare results (no envelope)', async () => {
    install({}, false);
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(w.ordinals.address).toBe(ADDR.main.p2tr);
  });

  describe('signPsbt', () => {
    it('sends base64 and groups signInputs by address', async () => {
      const { rec } = install();
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [
          { index: 0, address: ADDR.main.p2sh },
          { index: 1, address: ADDR.main.p2tr },
          { index: 3, address: ADDR.main.p2sh },
        ],
      });
      expect(rec.last('signPsbt')?.args[0]).toEqual({
        psbt: UNSIGNED_B64,
        signInputs: { [ADDR.main.p2sh]: [0, 3], [ADDR.main.p2tr]: [1] },
        broadcast: false,
      });
      expect(res).toEqual({ psbtBase64: SIGNED_B64 });
    });

    it('broadcast returns the txid', async () => {
      const { rec } = install({ signPsbt: () => ({ psbt: SIGNED_B64, txid: '12'.repeat(32) }) });
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }], broadcast: true });
      expect((rec.last('signPsbt')?.args[0] as { broadcast: boolean }).broadcast).toBe(true);
      expect(res.txid).toBe('12'.repeat(32));
    });

    it('rejection → UserRejectedError', async () => {
      install({ signPsbt: () => rpcError(-32000, 'User rejected') });
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }] })).rejects.toBeInstanceOf(
        UserRejectedError,
      );
    });

    it('other RPC errors → WALLET_ERROR with message', async () => {
      install({ signPsbt: () => rpcError(-32603, 'Internal error: bad psbt') });
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }] })).rejects.toMatchObject({
        code: 'WALLET_ERROR',
        message: expect.stringContaining('bad psbt'),
      });
    });

    it('empty result → WALLET_ERROR', async () => {
      install({ signPsbt: () => ({}) });
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }] })).rejects.toMatchObject({
        code: 'WALLET_ERROR',
      });
    });

    it('refuses inputs assigned to foreign addresses', async () => {
      const { rec } = install();
      const w = await xverseAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2pkh }] })).rejects.toMatchObject({
        code: 'ADDRESS_NOT_IN_WALLET',
      });
      expect(rec.last('signPsbt')).toBeUndefined();
    });
  });

  it('signMessage uses BIP322 by default and ECDSA on request', async () => {
    const { rec } = install();
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('hi', ADDR.main.p2tr)).toBe('xv-sig');
    expect(rec.last('signMessage')?.args[0]).toEqual({ address: ADDR.main.p2tr, message: 'hi', protocol: 'BIP322' });
    await w.signMessage('hi', ADDR.main.p2sh, 'ecdsa');
    expect(rec.last('signMessage')?.args[0]).toEqual({ address: ADDR.main.p2sh, message: 'hi', protocol: 'ECDSA' });
  });

  it('signMessage accepts a bare string signature result', async () => {
    install({ signMessage: () => 'bare-sig' });
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('hi', ADDR.main.p2tr)).toBe('bare-sig');
  });

  it('has no pushTx', async () => {
    install();
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    expect(w.pushTx).toBeUndefined();
  });

  it('disconnect calls wallet_disconnect and ignores failures', async () => {
    const { rec, handlers } = install();
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    await w.disconnect();
    expect(rec.methods()).toContain('wallet_disconnect');
    handlers.wallet_disconnect = () => {
      throw new Error('x');
    };
    await expect(w.disconnect()).resolves.toBeUndefined();
  });

  it('onAccountsChanged uses addListener(accountChange/networkChange)', async () => {
    const { emit, listeners } = install();
    const w = await xverseAdapter.connect({ network: 'mainnet' });
    let n = 0;
    const off = w.onAccountsChanged!(() => n++);
    emit('accountChange');
    emit('networkChange');
    expect(n).toBe(2);
    off();
    emit('accountChange');
    expect(n).toBe(2);
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('supports regtest', async () => {
    const regAddrs = [
      { address: ADDR.regtest.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals' },
      { address: ADDR.regtest.p2wpkh, publicKey: PUBKEY_B, purpose: 'payment' },
    ];
    const { rec } = install({ wallet_connect: () => ({ addresses: regAddrs, network: { bitcoin: { name: 'Regtest' } } }) });
    const w = await xverseAdapter.connect({ network: 'regtest' });
    expect((rec.calls[0]!.args[0] as { network: string }).network).toBe('Regtest');
    expect(w.payment.addressType).toBe('p2wpkh');
  });
});
