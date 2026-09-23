import { describe, expect, it } from 'vitest';
import {
  UnsupportedNetworkError,
  UserRejectedError,
  WalletNotInstalledError,
  unisatAdapter,
  type WalletError,
} from '../src/index.js';
import { ADDR, PUBKEY_A, Recorder, SIGNED_B64, SIGNED_HEX, UNSIGNED_B64, UNSIGNED_HEX, eip1193Rejection, win } from './helpers.js';

interface FakeOpts {
  api?: 'chain' | 'legacy' | 'none';
  chain?: string;
  legacyNetwork?: string;
  /** Address per chain enum / legacy network name. */
  addressFor?: Record<string, string>;
  switchSticks?: boolean;
  signResult?: string;
}

function fakeUnisat(opts: FakeOpts = {}) {
  const rec = new Recorder();
  const api = opts.api ?? 'chain';
  let chain = opts.chain ?? 'BITCOIN_MAINNET';
  let legacy = opts.legacyNetwork ?? 'livenet';
  const addressFor = opts.addressFor ?? {
    BITCOIN_MAINNET: ADDR.main.p2tr,
    BITCOIN_TESTNET4: ADDR.test.p2tr,
    BITCOIN_SIGNET: ADDR.test.p2tr,
    livenet: ADDR.main.p2wpkh,
    testnet: ADDR.test.p2wpkh,
  };
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const p: Record<string, unknown> = {
    async requestAccounts() {
      rec.record('requestAccounts', []);
      return [addressFor[api === 'legacy' ? legacy : chain]];
    },
    async getPublicKey() {
      rec.record('getPublicKey', []);
      return PUBKEY_A;
    },
    async signPsbt(hex: string, o: unknown) {
      rec.record('signPsbt', [hex, o]);
      return opts.signResult ?? SIGNED_HEX;
    },
    async signMessage(msg: string, type: string) {
      rec.record('signMessage', [msg, type]);
      return 'sig-base64';
    },
    async pushTx(arg: unknown) {
      rec.record('pushTx', [arg]);
      return 'ab'.repeat(32);
    },
    async pushPsbt(hex: string) {
      rec.record('pushPsbt', [hex]);
      return 'cd'.repeat(32);
    },
    async disconnect() {
      rec.record('disconnect', []);
    },
    on(ev: string, h: (...a: unknown[]) => void) {
      rec.record('on', [ev]);
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(h);
    },
    removeListener(ev: string, h: (...a: unknown[]) => void) {
      rec.record('removeListener', [ev]);
      listeners.get(ev)?.delete(h);
    },
  };
  if (api === 'chain') {
    p.getChain = async () => {
      rec.record('getChain', []);
      return { enum: chain, name: chain, network: 'x' };
    };
    p.switchChain = async (c: string) => {
      rec.record('switchChain', [c]);
      if (opts.switchSticks !== false) chain = c;
      return { enum: chain };
    };
  } else if (api === 'legacy') {
    p.getNetwork = async () => {
      rec.record('getNetwork', []);
      return legacy;
    };
    p.switchNetwork = async (n: string) => {
      rec.record('switchNetwork', [n]);
      if (opts.switchSticks !== false) legacy = n;
      return legacy;
    };
  }
  win().unisat = p;
  const emit = (ev: string, ...a: unknown[]) => listeners.get(ev)?.forEach((h) => h(...a));
  return { rec, p, emit, listeners };
}

describe('UniSat adapter', () => {
  it('reports not installed and throws WalletNotInstalledError', async () => {
    expect(unisatAdapter.isInstalled()).toBe(false);
    await expect(unisatAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
    win().unisat = { notAProvider: true };
    expect(unisatAdapter.isInstalled()).toBe(false);
  });

  it('detects installation', () => {
    fakeUnisat();
    expect(unisatAdapter.isInstalled()).toBe(true);
    expect(unisatAdapter.id).toBe('unisat');
    expect(unisatAdapter.installUrl).toMatch(/^https:\/\//);
  });

  it('connect maps the single address to both ordinals and payment', async () => {
    const { rec } = fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    expect(w.id).toBe('unisat');
    expect(w.network).toBe('mainnet');
    expect(w.ordinals).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals', addressType: 'p2tr' });
    expect(w.payment).toEqual({ address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'payment', addressType: 'p2tr' });
    // Already on mainnet: no switch.
    expect(rec.methods()).toEqual(['requestAccounts', 'getChain', 'getPublicKey']);
  });

  it('switches chain to testnet4 and re-reads accounts', async () => {
    const { rec } = fakeUnisat({ chain: 'BITCOIN_MAINNET' });
    const w = await unisatAdapter.connect({ network: 'testnet' });
    expect(rec.last('switchChain')?.args).toEqual(['BITCOIN_TESTNET4']);
    expect(rec.methods()).toEqual(['requestAccounts', 'getChain', 'switchChain', 'getChain', 'requestAccounts', 'getPublicKey']);
    expect(w.payment.address).toBe(ADDR.test.p2tr);
    expect(w.network).toBe('testnet');
  });

  it('switches chain to signet', async () => {
    const { rec } = fakeUnisat();
    await unisatAdapter.connect({ network: 'signet' });
    expect(rec.last('switchChain')?.args).toEqual(['BITCOIN_SIGNET']);
  });

  it('throws UnsupportedNetworkError when the switch does not take', async () => {
    fakeUnisat({ switchSticks: false });
    await expect(unisatAdapter.connect({ network: 'signet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('maps a rejected switchChain to UserRejectedError', async () => {
    const { p } = fakeUnisat();
    p.switchChain = async () => {
      throw eip1193Rejection();
    };
    await expect(unisatAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('maps a failing (non-rejection) switchChain to UnsupportedNetworkError', async () => {
    const { p } = fakeUnisat();
    p.switchChain = async () => {
      throw new Error('unknown chain');
    };
    await expect(unisatAdapter.connect({ network: 'testnet' })).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
  });

  it('refuses regtest up front (no UniSat chain for it)', async () => {
    const { rec } = fakeUnisat();
    await expect(unisatAdapter.connect({ network: 'regtest' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
    expect(rec.calls).toHaveLength(0);
  });

  it('falls back to getNetwork/switchNetwork on older builds', async () => {
    const { rec } = fakeUnisat({ api: 'legacy', legacyNetwork: 'livenet' });
    const w = await unisatAdapter.connect({ network: 'testnet' });
    expect(rec.last('switchNetwork')?.args).toEqual(['testnet']);
    expect(w.payment.address).toBe(ADDR.test.p2wpkh);
    expect(w.payment.addressType).toBe('p2wpkh');
  });

  it('legacy API cannot select signet', async () => {
    fakeUnisat({ api: 'legacy' });
    await expect(unisatAdapter.connect({ network: 'signet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('legacy API: failed switch is detected', async () => {
    fakeUnisat({ api: 'legacy', switchSticks: false });
    await expect(unisatAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
  });

  it('with no network API, validates the returned address prefix', async () => {
    fakeUnisat({ api: 'none', addressFor: { BITCOIN_MAINNET: ADDR.main.p2tr } });
    await expect(unisatAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
    await expect(unisatAdapter.connect({ network: 'mainnet' })).resolves.toMatchObject({ network: 'mainnet' });
  });

  it('maps connect rejection (code 4001) to UserRejectedError', async () => {
    const { p } = fakeUnisat();
    p.requestAccounts = async () => {
      throw eip1193Rejection();
    };
    const err = (await unisatAdapter.connect({ network: "mainnet" }).catch((e: unknown) => e)) as WalletError;
    expect(err).toBeInstanceOf(UserRejectedError);
    expect(err.code).toBe('USER_REJECTED');
    expect(err.walletId).toBe('unisat');
  });

  it('empty accounts → NOT_CONNECTED', async () => {
    const { p } = fakeUnisat();
    p.requestAccounts = async () => [];
    await expect(unisatAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  describe('signPsbt', () => {
    it('sends hex with autoFinalized=false and toSignInputs, returns base64', async () => {
      const { rec } = fakeUnisat();
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [
          { index: 0, address: ADDR.main.p2tr },
          { index: 2, address: ADDR.main.p2tr, sighashTypes: [0x01] },
        ],
      });
      expect(rec.last('signPsbt')?.args).toEqual([
        UNSIGNED_HEX,
        {
          autoFinalized: false,
          toSignInputs: [
            { index: 0, address: ADDR.main.p2tr },
            { index: 2, address: ADDR.main.p2tr, sighashTypes: [1] },
          ],
        },
      ]);
      expect(res).toEqual({ psbtBase64: SIGNED_B64 });
    });

    it('passes finalize through as autoFinalized', async () => {
      const { rec } = fakeUnisat();
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], finalize: true });
      expect((rec.last('signPsbt')?.args[1] as { autoFinalized: boolean }).autoFinalized).toBe(true);
    });

    it('broadcast forces finalize and pushes via pushPsbt', async () => {
      const { rec } = fakeUnisat();
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], broadcast: true });
      expect((rec.last('signPsbt')?.args[1] as { autoFinalized: boolean }).autoFinalized).toBe(true);
      expect(rec.last('pushPsbt')?.args).toEqual([SIGNED_HEX]);
      expect(res).toEqual({ psbtBase64: SIGNED_B64, txid: 'cd'.repeat(32) });
    });

    it('broadcast without pushPsbt → UNSUPPORTED_METHOD', async () => {
      const { p } = fakeUnisat();
      delete p.pushPsbt;
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      await expect(
        w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }], broadcast: true }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    });

    it('maps user rejection', async () => {
      const { p } = fakeUnisat();
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      p.signPsbt = async () => {
        throw new Error('User rejected the request.');
      };
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toBeInstanceOf(
        UserRejectedError,
      );
    });

    it('validates inputs before touching the wallet', async () => {
      const { rec } = fakeUnisat();
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      const before = rec.calls.length;
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: -1, address: ADDR.main.p2tr }] })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 1.5, address: ADDR.main.p2tr }] })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await expect(
        w.signPsbt(UNSIGNED_B64, {
          inputsToSign: [
            { index: 0, address: ADDR.main.p2tr },
            { index: 0, address: ADDR.main.p2tr },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }] })).rejects.toMatchObject({
        code: 'ADDRESS_NOT_IN_WALLET',
      });
      await expect(w.signPsbt('bm90IGEgcHNidA==', { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toMatchObject({
        code: 'INVALID_PSBT',
      });
      expect(rec.calls.length).toBe(before);
    });

    it('rejects a non-PSBT response from the wallet', async () => {
      fakeUnisat({ signResult: 'deadbeef' });
      const w = await unisatAdapter.connect({ network: 'mainnet' });
      await expect(w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2tr }] })).rejects.toMatchObject({
        code: 'INVALID_PSBT',
      });
    });
  });

  it('signMessage defaults to bip322-simple and supports ecdsa', async () => {
    const { rec } = fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    expect(await w.signMessage('hello', ADDR.main.p2tr)).toBe('sig-base64');
    expect(rec.last('signMessage')?.args).toEqual(['hello', 'bip322-simple']);
    await w.signMessage('hello', ADDR.main.p2tr, 'ecdsa');
    expect(rec.last('signMessage')?.args).toEqual(['hello', 'ecdsa']);
  });

  it('signMessage refuses an address that is not the connected one', async () => {
    fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    await expect(w.signMessage('x', ADDR.main.p2wpkh)).rejects.toMatchObject({ code: 'ADDRESS_NOT_IN_WALLET' });
  });

  it('pushTx sends { rawtx }', async () => {
    const { rec } = fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    expect(await w.pushTx!('0200')).toBe('ab'.repeat(32));
    expect(rec.last('pushTx')?.args).toEqual([{ rawtx: '0200' }]);
  });

  it('disconnect calls provider.disconnect when present and swallows errors', async () => {
    const { rec, p } = fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    await w.disconnect();
    expect(rec.methods()).toContain('disconnect');
    p.disconnect = async () => {
      throw new Error('nope');
    };
    await expect(w.disconnect()).resolves.toBeUndefined();
  });

  it('onAccountsChanged subscribes to account/network events and unsubscribes', async () => {
    const { emit, listeners } = fakeUnisat();
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    let n = 0;
    const off = w.onAccountsChanged!(() => n++);
    emit('accountsChanged', ['x']);
    emit('networkChanged', 'testnet');
    expect(n).toBe(2);
    off();
    emit('accountsChanged', ['y']);
    expect(n).toBe(2);
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});
