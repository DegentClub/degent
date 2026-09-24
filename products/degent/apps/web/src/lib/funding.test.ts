import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import {
  buildFundingPsbt,
  classifyAddress,
  compareOutputs,
  dustLimit,
  extractSignedTx,
  InsufficientFundsError,
  LegacyAddressError,
  selectCoins,
} from './funding';
import { createFakeWallets, fakeAddress, fakeCommitAddress } from '../services/fakes';
import type { Utxo } from '../services/types';

const commit = fakeCommitAddress('11'.repeat(32), 'ab'.repeat(32), 'image/webp', undefined, 'mainnet');
const feeAddr = fakeAddress('fee', 'mainnet');
const utxo = (value: number, i = 0, confirmed = true): Utxo => ({
  txid: (i + 1).toString(16).padStart(64, '0'),
  vout: i,
  value,
  status: { confirmed },
});

describe('address classification', () => {
  it('recognises the payment types we can and cannot use', () => {
    expect(classifyAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe('p2tr');
    expect(classifyAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe('p2wpkh');
    expect(classifyAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('p2sh-p2wpkh');
    expect(classifyAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('p2pkh');
    expect(classifyAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe('p2wpkh');
  });
});

describe('selectCoins', () => {
  const targets = [{ address: commit, value: 100_000, label: 'commit' as const }];

  it('prefers confirmed, larger coins and returns change above dust', () => {
    const r = selectCoins({
      utxos: [utxo(50_000, 0), utxo(500_000, 1, false), utxo(300_000, 2)],
      inputType: 'p2wpkh',
      targets,
      changeAddress: feeAddr,
      feeRate: 5,
      guardInscriptions: false,
    });
    expect(r.inputs.map((u) => u.value)).toEqual([300_000]);
    const change = r.outputs.find((o) => o.label === 'change')!;
    expect(change.value + r.fee + 100_000).toBe(300_000);
    expect(r.fee).toBe(Math.ceil((10.5 + 43 + 68 + 31) * 5));
  });

  it('drops dust change into the fee', () => {
    const r = selectCoins({
      utxos: [utxo(100_000 + 600)],
      inputType: 'p2wpkh',
      targets,
      changeAddress: feeAddr,
      feeRate: 1,
      guardInscriptions: false,
    });
    expect(r.outputs.some((o) => o.label === 'change')).toBe(false);
    expect(r.fee).toBe(600);
  });

  it('never spends small coins when payment doubles as the ordinals address', () => {
    const r = selectCoins({
      utxos: [utxo(546, 0), utxo(10_000, 1), utxo(400_000, 2)],
      inputType: 'p2tr',
      targets,
      changeAddress: feeAddr,
      feeRate: 2,
      guardInscriptions: true,
    });
    expect(r.excluded.map((u) => u.value)).toEqual([546, 10_000]);
    expect(r.inputs.map((u) => u.value)).toEqual([400_000]);
  });

  it('throws a clear error when funds are short', () => {
    expect(() =>
      selectCoins({ utxos: [utxo(1_000)], inputType: 'p2wpkh', targets, changeAddress: feeAddr, feeRate: 2, guardInscriptions: false }),
    ).toThrow(InsufficientFundsError);
  });
});

describe('buildFundingPsbt: txid is known before signing', () => {
  for (const paymentType of ['p2wpkh', 'p2sh-p2wpkh', 'p2tr'] as const) {
    it(`${paymentType}: the wallet-signed tx has exactly the precomputed txid`, async () => {
      const w = await createFakeWallets([], { paymentType }).connect('xverse', 'mainnet');
      const f = buildFundingPsbt({
        network: 'mainnet',
        utxos: [utxo(900_000, 0), utxo(3_000, 1)],
        payment: w.payment,
        ordinalsAddress: w.ordinals.address,
        commitAddress: commit,
        commitValue: 250_000,
        serviceFee: { address: feeAddr, value: 25_000 },
        feeRate: 3,
      });
      expect(f.commitVout).toBe(0);
      const tx = btc.Transaction.fromPSBT(base64.decode(f.psbtBase64));
      expect(tx.getOutputAddress(0)).toBe(commit);
      expect(tx.getOutput(0).amount).toBe(250_000n);
      expect(tx.getOutputAddress(1)).toBe(feeAddr);
      expect(tx.getOutput(1).amount).toBe(25_000n);
      expect(f.inputsToSign).toEqual([{ index: 0, address: w.payment.address }]);

      const signed = await w.signPsbt(f.psbtBase64, { inputsToSign: f.inputsToSign, finalize: true, broadcast: false });
      const { txid, hex } = extractSignedTx(signed.psbtBase64);
      expect(txid).toBe(f.txid);
      expect(hex.length).toBeGreaterThan(100);
    });
  }

  it('refuses legacy payment addresses with an actionable message', async () => {
    const w = await createFakeWallets([], { paymentType: 'p2pkh' }).connect('unisat', 'mainnet');
    expect(() =>
      buildFundingPsbt({
        network: 'mainnet',
        utxos: [utxo(900_000)],
        payment: w.payment,
        ordinalsAddress: w.ordinals.address,
        commitAddress: commit,
        commitValue: 250_000,
        serviceFee: null,
        feeRate: 3,
      }),
    ).toThrow(LegacyAddressError);
    expect(new LegacyAddressError('1abc').message).toMatch(/SegWit or Taproot/);
  });

  it('omits the service-fee output when the fee is zero', async () => {
    const w = await createFakeWallets().connect('unisat', 'mainnet');
    const f = buildFundingPsbt({
      network: 'mainnet',
      utxos: [utxo(900_000)],
      payment: w.payment,
      ordinalsAddress: w.ordinals.address,
      commitAddress: commit,
      commitValue: 250_000,
      serviceFee: { address: feeAddr, value: 0 },
      feeRate: 3,
    });
    expect(f.selection.outputs.map((o) => o.label)).toEqual(['commit', 'change']);
  });
});

describe('buildFundingPsbt: the artist royalty (ADR-0007 §5, plan §3.2)', () => {
  const artist = fakeAddress('artist-payout', 'mainnet');

  it('places the royalty at [1], between the commit and the club fee, change last', async () => {
    const w = await createFakeWallets().connect('xverse', 'mainnet');
    const f = buildFundingPsbt({
      network: 'mainnet',
      utxos: [utxo(900_000)],
      payment: w.payment,
      ordinalsAddress: w.ordinals.address,
      commitAddress: commit,
      commitValue: 250_000,
      artistRoyalty: { address: artist, value: 5_000 },
      serviceFee: { address: feeAddr, value: 45_000 },
      feeRate: 3,
    });
    expect(f.selection.outputs.map((o) => o.label)).toEqual(['commit', 'artist-royalty', 'service-fee', 'change']);
    expect(f.royaltyVout).toBe(1);
    expect(f.commitVout).toBe(0);
    const tx = btc.Transaction.fromPSBT(base64.decode(f.psbtBase64));
    expect(tx.getOutputAddress(1)).toBe(artist);
    expect(tx.getOutput(1).amount).toBe(5_000n);
    expect(tx.getOutputAddress(2)).toBe(feeAddr);
    expect(f.outputs.map((o) => o.label)).toEqual(['commit', 'artist-royalty', 'service-fee', 'change']);
    expect(f.outputs[1]).toMatchObject({ value: 5_000, script: hex.encode(tx.getOutput(1).script!) });
    expect(f.notes).toEqual([]);
    // The signed transaction reproduces exactly those outputs.
    const signed = await w.signPsbt(f.psbtBase64, { inputsToSign: f.inputsToSign, finalize: true, broadcast: false });
    const ex = extractSignedTx(signed.psbtBase64);
    expect(ex.txid).toBe(f.txid);
    expect(ex.outputs).toEqual(f.outputs.map(({ script, value }) => ({ script, value })));
    expect(compareOutputs(f.outputs, ex.outputs)).toBeNull();
  });

  it('omits the royalty output when it is 0 (and when there is none)', async () => {
    const w = await createFakeWallets().connect('unisat', 'mainnet');
    const base = { network: 'mainnet' as const, utxos: [utxo(900_000)], payment: w.payment, ordinalsAddress: w.ordinals.address, commitAddress: commit, commitValue: 250_000, serviceFee: { address: feeAddr, value: 25_000 }, feeRate: 3 };
    const zero = buildFundingPsbt({ ...base, artistRoyalty: { address: artist, value: 0 } });
    expect(zero.selection.outputs.map((o) => o.label)).toEqual(['commit', 'service-fee', 'change']);
    expect(zero.royaltyVout).toBeNull();
    const none = buildFundingPsbt({ ...base, artistRoyalty: null });
    expect(none.selection.outputs.map((o) => o.label)).toEqual(['commit', 'service-fee', 'change']);
    expect(none.txid).toBe(zero.txid);
  });

  it('raises a royalty below the payout script’s dust limit to that limit and says so', async () => {
    const w = await createFakeWallets().connect('unisat', 'mainnet');
    const f = buildFundingPsbt({
      network: 'mainnet',
      utxos: [utxo(900_000)],
      payment: w.payment,
      ordinalsAddress: w.ordinals.address,
      commitAddress: commit,
      commitValue: 250_000,
      artistRoyalty: { address: artist, value: 100 },
      serviceFee: null,
      feeRate: 3,
    });
    expect(dustLimit(artist)).toBe(294);
    expect(f.selection.outputs.map((o) => [o.label, o.value])).toEqual([
      ['commit', 250_000],
      ['artist-royalty', 294],
      ['change', expect.any(Number)],
    ]);
    expect(f.notes[0]).toMatch(/100 sats is below the 294-sat dust limit .* raised to 294 sats/);
    expect(dustLimit('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe(330);
  });

  it('compareOutputs names the first output whose script or value differs', () => {
    const expected = [
      { script: '00', value: 1, label: 'commit' as const },
      { script: '01', value: 5_000, label: 'artist-royalty' as const },
    ];
    expect(compareOutputs(expected, [{ script: '00', value: 1 }, { script: '01', value: 5_000 }])).toBeNull();
    expect(compareOutputs(expected, [{ script: '00', value: 1 }, { script: '01', value: 4_999 }])).toBe('output 1 (Artist royalty) value changed from 5000 to 4999 sats');
    expect(compareOutputs(expected, [{ script: '00', value: 1 }, { script: '02', value: 5_000 }])).toBe('output 1 (Artist royalty) pays a different script');
    expect(compareOutputs(expected, [{ script: '00', value: 1 }])).toBe('expected 2 outputs, the signed transaction has 1');
  });
});
