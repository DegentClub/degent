import { describe, expect, it } from 'vitest';
import { UnsupportedNetworkError, UserRejectedError, WalletNotInstalledError, okxAdapter } from '../src/index.js';
import { ADDR, PUBKEY_A, Recorder, SIGNED_B64, SIGNED_HEX, UNSIGNED_B64, UNSIGNED_HEX, eip1193Rejection, win } from './helpers.js';

function fakeOkxProvider(rec: Recorder, tag: string, address: string) {
  const handlers = new Set<(...a: unknown[]) => void>();
  return {
    handlers,
    async connect() {
      rec.record(`${tag}.connect`, []);
      return { address, publicKey: PUBKEY_A };
    },
    async signPsbt(hex: string, o: unknown) {
      rec.record(`${tag}.signPsbt`, [hex, o]);
      return SIGNED_HEX;
    },
    async signMessage(m: string, t: string) {
      rec.record(`${tag}.signMessage`, [m, t]);
      return 'okx-sig';
    },
    async pushTx(raw: unknown) {
      rec.record(`${tag}.pushTx`, [raw]);
      return 'ee'.repeat(32);
    },
    async pushPsbt(hex: string) {
      rec.record(`${tag}.pushPsbt`, [hex]);
      return 'ff'.repeat(32);
    },
    async disconnect() {
      rec.record(`${tag}.disconnect`, []);
    },
    on(ev: string, h: (...a: unknown[]) => void) {
      rec.record(`${tag}.on`, [ev]);
      handlers.add(h);
    },
    removeListener(_ev: string, h: (...a: unknown[]) => void) {
      handlers.delete(h);
    },
  };
}

function install(which: Array<'bitcoin' | 'bitcoinTestnet' | 'bitcoinSignet'> = ['bitcoin', 'bitcoinTestnet', 'bitcoinSignet']) {
  const rec = new Recorder();
  const addr = { bitcoin: ADDR.main.p2wpkh, bitcoinTestnet: ADDR.test.p2wpkh, bitcoinSignet: ADDR.test.p2tr };
  const okx: Record<string, ReturnType<typeof fakeOkxProvider>> = {};
  for (const k of which) okx[k] = fakeOkxProvider(rec, k, addr[k]);
  win().okxwallet = okx;
  return { rec, okx };
}

describe('OKX adapter', () => {
  it('not installed', async () => {
    expect(okxAdapter.isInstalled()).toBe(false);
    await expect(okxAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
    // An okxwallet object with only EVM bits does not count.
    win().okxwallet = { ethereum: {} };
    expect(okxAdapter.isInstalled()).toBe(false);
  });

  it('installed when only a test-network provider exists', () => {
    install(['bitcoinTestnet']);
    expect(okxAdapter.isInstalled()).toBe(true);
  });

  it.each([
    ['mainnet', 'bitcoin', ADDR.main.p2wpkh],
    ['testnet', 'bitcoinTestnet', ADDR.test.p2wpkh],
    ['signet', 'bitcoinSignet', ADDR.test.p2tr],
  ] as const)('connect(%s) uses window.okxwallet.%s', async (network, key, address) => {
    const { rec } = install();
    const w = await okxAdapter.connect({ network });
    expect(rec.methods()).toEqual([`${key}.connect`]);
    expect(w.ordinals.address).toBe(address);
    expect(w.payment.address).toBe(address);
    expect(w.ordinals.purpose).toBe('ordinals');
    expect(w.payment.purpose).toBe('payment');
    expect(w.payment.publicKey).toBe(PUBKEY_A);
  });

  it('missing network provider → UnsupportedNetworkError', async () => {
    install(['bitcoin']);
    await expect(okxAdapter.connect({ network: 'signet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('regtest unsupported', async () => {
    install();
    await expect(okxAdapter.connect({ network: 'regtest' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('address on the wrong network → UnsupportedNetworkError', async () => {
    const { okx } = install();
    okx.bitcoinTestnet!.connect = async () => ({ address: ADDR.main.p2tr, publicKey: PUBKEY_A });
    await expect(okxAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('connect rejection → UserRejectedError', async () => {
    const { okx } = install();
    okx.bitcoin!.connect = async () => {
      throw eip1193Rejection();
    };
    await expect(okxAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('signPsbt goes to the same network provider, as hex', async () => {
    const { rec } = install();
    const w = await okxAdapter.connect({ network: 'testnet' });
    const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 1, address: ADDR.test.p2wpkh }] });
    expect(rec.last('bitcoinTestnet.signPsbt')?.args).toEqual([
      UNSIGNED_HEX,
      { autoFinalized: false, toSignInputs: [{ index: 1, address: ADDR.test.p2wpkh }] },
    ]);
    expect(rec.last('bitcoin.signPsbt')).toBeUndefined();
    expect(res.psbtBase64).toBe(SIGNED_B64);
  });

  it('broadcast uses pushPsbt; pushTx passes the raw hex string', async () => {
    const { rec } = install();
    const w = await okxAdapter.connect({ network: 'mainnet' });
    const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }], broadcast: true });
    expect(res.txid).toBe('ff'.repeat(32));
    expect(await w.pushTx!('0200')).toBe('ee'.repeat(32));
    expect(rec.last('bitcoin.pushTx')?.args).toEqual(['0200']);
  });

  it('signPsbt rejection → UserRejectedError', async () => {
    const { okx } = install();
    const w = await okxAdapter.connect({ network: 'mainnet' });
    okx.bitcoin!.signPsbt = async () => {
      throw { code: 4001, message: 'User rejected' };
    };
    await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }] })).rejects.toBeInstanceOf(
      UserRejectedError,
    );
  });

  it('signMessage bip322-simple by default', async () => {
    const { rec } = install();
    const w = await okxAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('m', ADDR.main.p2wpkh)).toBe('okx-sig');
    expect(rec.last('bitcoin.signMessage')?.args).toEqual(['m', 'bip322-simple']);
  });

  it('listens for accountChanged', async () => {
    const { okx } = install();
    const w = await okxAdapter.connect({ network: 'mainnet' });
    let n = 0;
    const off = w.onAccountsChanged!(() => n++);
    okx.bitcoin!.handlers.forEach((h) => h({ address: 'x' }));
    expect(n).toBeGreaterThan(0);
    off();
    expect(okx.bitcoin!.handlers.size).toBe(0);
  });

  it('disconnect is forwarded', async () => {
    const { rec } = install();
    const w = await okxAdapter.connect({ network: 'mainnet' });
    await w.disconnect();
    expect(rec.methods()).toContain('bitcoin.disconnect');
  });
});
