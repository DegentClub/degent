import { base64urlnopad, utf8 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { UnsupportedNetworkError, UserRejectedError, WalletNotInstalledError, magicEdenAdapter } from '../src/index.js';
import { unsecuredToken } from '../src/adapters/magiceden.js';
import { ADDR, PUBKEY_A, PUBKEY_B, Recorder, SIGNED_B64, UNSIGNED_B64, win } from './helpers.js';
import { fakeRpcProvider, rpcError } from './sats-fake.js';

const ADDRS = [
  { address: ADDR.main.p2tr, publicKey: PUBKEY_A, purpose: 'ordinals' },
  { address: ADDR.main.p2wpkh, publicKey: PUBKEY_B, purpose: 'payment' },
];

function decodeToken(t: string): { header: unknown; payload: Record<string, unknown>; sig: string } {
  const [h, p, sig] = t.split('.');
  const dec = (s: string) => JSON.parse(utf8.encode(base64urlnopad.decode(s)));
  return { header: dec(h!), payload: dec(p!), sig: sig! };
}

describe('Magic Eden adapter', () => {
  it('not installed', async () => {
    expect(magicEdenAdapter.isInstalled()).toBe(false);
    await expect(magicEdenAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(WalletNotInstalledError);
  });

  it('mainnet only', async () => {
    const f = fakeRpcProvider({ getAccounts: () => ADDRS });
    win().magicEden = { bitcoin: f.p };
    await expect(magicEdenAdapter.connect({ network: 'testnet' })).rejects.toBeInstanceOf(UnsupportedNetworkError);
    expect(f.rec.calls).toHaveLength(0);
  });

  describe('request API (sats-connect)', () => {
    function install(extra = {}) {
      const f = fakeRpcProvider({
        getAccounts: () => ADDRS,
        signPsbt: () => ({ psbt: SIGNED_B64 }),
        signMessage: () => ({ signature: 'me-sig' }),
        ...extra,
      });
      win().magicEden = { bitcoin: f.p };
      return f;
    }

    it('connect falls through wallet_connect → getAccounts and maps purposes', async () => {
      const { rec } = install();
      expect(magicEdenAdapter.isInstalled()).toBe(true);
      const w = await magicEdenAdapter.connect({ network: 'mainnet' });
      expect(rec.methods()).toEqual(['wallet_connect', 'getAccounts']);
      expect(w.id).toBe('magiceden');
      expect(w.ordinals).toMatchObject({ address: ADDR.main.p2tr, purpose: 'ordinals', addressType: 'p2tr' });
      expect(w.payment).toMatchObject({ address: ADDR.main.p2wpkh, purpose: 'payment', addressType: 'p2wpkh' });
    });

    it('signPsbt base64 + signInputs', async () => {
      const { rec } = install();
      const w = await magicEdenAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, { inputsToSign: [{ index: 0, address: ADDR.main.p2wpkh }] });
      expect(rec.last('signPsbt')?.args[0]).toEqual({
        psbt: UNSIGNED_B64,
        signInputs: { [ADDR.main.p2wpkh]: [0] },
        broadcast: false,
      });
      expect(res.psbtBase64).toBe(SIGNED_B64);
    });

    it('rejection → UserRejectedError', async () => {
      install({ getAccounts: () => rpcError(-32000, 'User rejected') });
      await expect(magicEdenAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    });
  });

  describe('legacy v1 JWT API', () => {
    function install() {
      const rec = new Recorder();
      const p = {
        async connect(token: string) {
          rec.record('connect', [token]);
          return { addresses: ADDRS };
        },
        async signTransaction(token: string) {
          rec.record('signTransaction', [token]);
          return { psbtBase64: SIGNED_B64, txId: '56'.repeat(32) };
        },
        async signMessage(token: string) {
          rec.record('signMessage', [token]);
          return 'legacy-sig';
        },
      };
      win().magicEden = { bitcoin: p };
      return { rec, p };
    }

    it('unsecuredToken is header.payload. with alg none', () => {
      const t = unsecuredToken({ a: 1 });
      expect(t.endsWith('.')).toBe(true);
      const d = decodeToken(t);
      expect(d.header).toEqual({ typ: 'JWT', alg: 'none' });
      expect(d.payload).toEqual({ a: 1 });
      expect(d.sig).toBe('');
    });

    it('connect sends purposes + network in a token', async () => {
      const { rec } = install();
      const w = await magicEdenAdapter.connect({ network: 'mainnet' });
      const payload = decodeToken(rec.last('connect')!.args[0] as string).payload;
      expect(payload).toMatchObject({ purposes: ['ordinals', 'payment'], network: { type: 'Mainnet' } });
      expect(w.ordinals.address).toBe(ADDR.main.p2tr);
      expect(w.payment.address).toBe(ADDR.main.p2wpkh);
    });

    it('signTransaction groups inputs per address with signingIndexes; returns txid', async () => {
      const { rec } = install();
      const w = await magicEdenAdapter.connect({ network: 'mainnet' });
      const res = await w.signPsbt(UNSIGNED_B64, {
        inputsToSign: [
          { index: 0, address: ADDR.main.p2wpkh, sighashTypes: [0x01] },
          { index: 1, address: ADDR.main.p2wpkh, sighashTypes: [0x01] },
          { index: 2, address: ADDR.main.p2tr },
        ],
        broadcast: true,
      });
      const payload = decodeToken(rec.last('signTransaction')!.args[0] as string).payload;
      expect(payload).toMatchObject({
        psbtBase64: UNSIGNED_B64,
        broadcast: true,
        network: { type: 'Mainnet' },
        inputsToSign: [
          { address: ADDR.main.p2wpkh, signingIndexes: [0, 1], sigHash: 1 },
          { address: ADDR.main.p2tr, signingIndexes: [2] },
        ],
      });
      expect(res).toEqual({ psbtBase64: SIGNED_B64, txid: '56'.repeat(32) });
    });

    it('signMessage via token, BIP322 by default', async () => {
      const { rec } = install();
      const w = await magicEdenAdapter.connect({ network: 'mainnet' });
      expect(await w.signMessage('yo', ADDR.main.p2tr)).toBe('legacy-sig');
      expect(decodeToken(rec.last('signMessage')!.args[0] as string).payload).toMatchObject({
        address: ADDR.main.p2tr,
        message: 'yo',
        protocol: 'BIP322',
      });
    });

    it('maps a thrown cancel to UserRejectedError', async () => {
      const { p } = install();
      p.connect = async () => {
        throw new Error('User canceled the request');
      };
      await expect(magicEdenAdapter.connect({ network: 'mainnet' })).rejects.toBeInstanceOf(UserRejectedError);
    });
  });

  it('an injected object with no usable API → UNSUPPORTED_METHOD', async () => {
    win().magicEden = { bitcoin: { isMagicEden: true } };
    expect(magicEdenAdapter.isInstalled()).toBe(false);
    await expect(magicEdenAdapter.connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
  });
});
