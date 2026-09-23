import { describe, expect, it } from 'vitest';
import { UnsupportedNetworkError, UserRejectedError, WalletNotInstalledError, leatherAdapter } from '../src/index.js';
import { ADDR, PUBKEY_A, PUBKEY_B, SIGNED_HEX, SIGNED_B64, UNSIGNED_B64, UNSIGNED_HEX, win } from './helpers.js';
import { fakeRpcProvider, type Handler } from './sats-fake.js';

const addrs = (set: { p2tr: string; p2wpkh: string }) => ({
  addresses: [
    { symbol: 'BTC', type: 'p2wpkh', address: set.p2wpkh, publicKey: PUBKEY_B, derivationPath: "m/84'/0'/0'/0/0" },
    { symbol: 'BTC', type: 'p2tr', address: set.p2tr, publicKey: PUBKEY_A, tweakedPublicKey: 'aa'.repeat(32) },
    { symbol: 'STX', address: 'SP000000000000000000002Q6VF78' },
  ],
});

function install(handlers: Record<string, Handler> = {}) {
  const f = fakeRpcProvider({
    getAddresses: () => addrs(ADDR.main),
    signPsbt: () => ({ hex: SIGNED_HEX }),
    signMessage: (p) => ({ signature: 'leather-sig', address: ADDR.main.p2wpkh, ...(p as object) }),
    ...handlers,
  });
  win().LeatherProvider = f.p;
  return f;
}

/** Leather rejects with the JSON-RPC response object. */
const leatherRejection = () => {
  throw { jsonrpc: '2.0', id: '1', error: { code: 4001, message: 'User rejected request' } };
};

describe('Leather adapter', () => {
  it('not installed', async () => {
    expect(leatherAdapter.isInstalled()).toBe(false);
    await expect(leatherAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
  });

  it('connect maps p2tr → ordinals and p2wpkh → payment, ignoring STX', async () => {
    const { rec } = install();
    expect(leatherAdapter.isInstalled()).toBe(true);
    const w = await leatherAdapter.connect({ network: 'mainnet' });
    expect(rec.calls[0]?.method).toBe('getAddresses');
    expect(w.ordinals).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' });
    expect(w.payment).toEqual({ address: ADDR.main.p2wpkh, publicKey: PUBKEY_B, purpose: 'payment', addressType: 'p2wpkh' });
  });

  it('infers type from the address when Leather omits it', async () => {
    install({
      getAddresses: () => ({
        addresses: [
          { address: ADDR.test.p2tr, publicKey: PUBKEY_A },
          { address: ADDR.test.p2wpkh, publicKey: PUBKEY_B },
        ],
      }),
    });
    const w = await leatherAdapter.connect({ network: 'signet' });
    expect(w.ordinals.address).toBe(ADDR.test.p2tr);
    expect(w.payment.address).toBe(ADDR.test.p2wpkh);
  });

  it('validates network from the returned addresses', async () => {
    install();
    await expect(leatherAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
    install({ getAddresses: () => addrs(ADDR.regtest) });
    await expect(leatherAdapter.connect({ network: 'regtest' })).resolves.toMatchObject({ network: 'regtest' });
  });

  it('connect rejection → UserRejectedError', async () => {
    install({ getAddresses: leatherRejection });
    await expect(leatherAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('missing taproot account → NOT_CONNECTED', async () => {
    install({ getAddresses: () => ({ addresses: [addrs(ADDR.main).addresses[0]] }) });
    await expect(leatherAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  describe('signPsbt', () => {
    it('sends hex + signAtIndex + network, returns base64', async () => {
      const { rec } = install();
      const w = await leatherAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [
          { index: 0, address: ADDR.main.p2wpkh },
          { index: 2, address: ADDR.main.p2tr },
        ],
      });
      expect(rec.last('signPsbt')?.args[0]).toEqual({ hex: UNSIGNED_HEX, signAtIndex: [0, 2], network: 'mainnet', broadcast: false });
      expect(res).toEqual({ psbtBase64: SIGNED_B64 });
    });

    it('forwards sighash types as allowedSighash and broadcast → txid', async () => {
      const { rec } = install({ signPsbt: () => ({ hex: SIGNED_HEX, txid: '34'.repeat(32) }) });
      const w = await leatherAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [{ index: 1, address: ADDR.main.p2wpkh, sighashTypes: [0x01] }],
        broadcast: true,
      });
      expect(rec.last('signPsbt')?.args[0]).toMatchObject({ allowedSighash: [1], broadcast: true });
      expect(res.txid).toBe('34'.repeat(32));
    });

    it('rejection → UserRejectedError', async () => {
      install({ signPsbt: leatherRejection });
      const w = await leatherAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }] })).rejects.toBeInstanceOf(
        UserRejectedError,
      );
    });

    it('refuses inputs not owned by the wallet (Leather signs by index only)', async () => {
      const { rec } = install();
      const w = await leatherAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2sh }] })).rejects.toMatchObject({
        code: 'ADDRESS_NOT_IN_WALLET',
      });
      expect(rec.last('signPsbt')).toBeUndefined();
    });
  });

  it('signMessage picks paymentType from the address and returns the signature', async () => {
    const { rec } = install({ signMessage: (p) => ({ signature: 'sig', ...(p as object) }) });
    const w = await leatherAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('m', ADDR.main.p2tr)).toBe('sig');
    expect(rec.last('signMessage')?.args[0]).toEqual({ message: 'm', paymentType: 'p2tr', network: 'mainnet' });
    await w.signMessage('m', ADDR.main.p2wpkh);
    expect(rec.last('signMessage')?.args[0]).toMatchObject({ paymentType: 'p2wpkh' });
  });

  it('signMessage refuses ecdsa and detects a mismatched signing address', async () => {
    install({ signMessage: () => ({ signature: 'sig', address: ADDR.main.p2tr }) });
    const w = await leatherAdapter.connect({ network: 'mainnet' });
    await expect(w.signMessage('m', ADDR.main.p2wpkh, 'ecdsa')).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    await expect(w.signMessage('m', ADDR.main.p2wpkh)).rejects.toMatchObject({ code: 'WALLET_ERROR' });
  });

  it('has no pushTx / events; disconnect is a no-op', async () => {
    install();
    const w = await leatherAdapter.connect({ network: 'mainnet' });
    expect(w.pushTx).toBeUndefined();
    expect(w.onAccountsChanged).toBeUndefined();
    await expect(w.disconnect()).resolves.toBeUndefined();
  });
});
