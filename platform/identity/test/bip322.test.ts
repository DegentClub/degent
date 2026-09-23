import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bip322MessageHash,
  bip322SighashP2tr,
  bip322SighashP2wpkh,
  bip322VirtualTxids,
  decodeAddress,
  decodeWitness,
  encodeWitness,
  signBip322Simple,
  txidHex,
  verifyBip322Simple,
} from '../src/index.js';
import { concatBytes, encodeBase64 } from '../src/bytes.js';
import { hash160 } from '../src/bip322.js';
import { BIP322_P2TR, BIP322_P2WPKH, BIP322_PRIV, addr, flipBase64Byte, key } from './helpers.js';

/**
 * Official vectors from BIP-322 ("Test vectors" section,
 * https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki). ECDSA is randomised, so the
 * BIP publishes two different valid P2WPKH signatures for "Hello World"; both must verify.
 */
const V = {
  msgHashEmpty: 'c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1',
  msgHashHello: 'f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a',
  toSpendEmpty: 'c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7',
  toSignEmpty: '1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6',
  toSpendHello: 'b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b',
  toSignHello: '88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf',
  p2wpkhEmpty:
    'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
  p2wpkhHello:
    'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
  p2wpkhHello2:
    'AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy',
  p2trHello: 'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==',
};

describe('BIP-322 published vectors', () => {
  it('message hashes', () => {
    expect(hex.encode(bip322MessageHash(''))).toBe(V.msgHashEmpty);
    expect(hex.encode(bip322MessageHash('Hello World'))).toBe(V.msgHashHello);
  });

  it('to_spend / to_sign txids for the P2WPKH challenge', () => {
    const script = decodeAddress(BIP322_P2WPKH, 'mainnet').script;
    const e = bip322VirtualTxids(script, '');
    expect(txidHex(e.toSpendTxid)).toBe(V.toSpendEmpty);
    expect(txidHex(e.toSignTxid)).toBe(V.toSignEmpty);
    const h = bip322VirtualTxids(script, 'Hello World');
    expect(txidHex(h.toSpendTxid)).toBe(V.toSpendHello);
    expect(txidHex(h.toSignTxid)).toBe(V.toSignHello);
  });

  it('the vector key controls the vector addresses', () => {
    expect(addr('wpkh', BIP322_PRIV)).toBe(BIP322_P2WPKH);
    expect(addr('tr', BIP322_PRIV)).toBe(BIP322_P2TR);
  });

  it.each([
    ['empty message', '', V.p2wpkhEmpty],
    ['"Hello World"', 'Hello World', V.p2wpkhHello],
    ['"Hello World" (second signature)', 'Hello World', V.p2wpkhHello2],
  ])('P2WPKH %s verifies', (_n, msg, sig) => {
    expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', msg, sig)).toEqual({ valid: true, kind: 'p2wpkh' });
  });

  it('P2TR "Hello World" (SIGHASH_ALL, 65-byte sig) verifies', () => {
    expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', 'Hello World', V.p2trHello)).toEqual({ valid: true, kind: 'p2tr' });
  });

  it('vectors do not verify against the other message', () => {
    expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', 'Hello World', V.p2wpkhEmpty).valid).toBe(false);
    expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', '', V.p2wpkhHello).valid).toBe(false);
    expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', '', V.p2trHello).valid).toBe(false);
    expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', 'Hello World!', V.p2trHello).valid).toBe(false);
  });

  it('vectors do not verify for another address', () => {
    const other = addr('wpkh', key(7));
    expect(verifyBip322Simple(other, 'mainnet', 'Hello World', V.p2wpkhHello)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('does not match'),
    });
    expect(verifyBip322Simple(addr('tr', key(7)), 'mainnet', 'Hello World', V.p2trHello).valid).toBe(false);
    // Same key, wrong address type: a P2WPKH witness is not a P2TR witness.
    expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', 'Hello World', V.p2wpkhHello).valid).toBe(false);
    expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', 'Hello World', V.p2trHello).valid).toBe(false);
  });

  it('tampered vectors fail (every byte of the P2TR signature)', () => {
    const raw = Buffer.from(V.p2trHello, 'base64');
    for (let i = 2; i < 2 + 64; i++) {
      expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', 'Hello World', flipBase64Byte(V.p2trHello, i)).valid).toBe(false);
    }
    expect(raw.length).toBe(67);
    // sighash byte 0x01 -> 0x00 changes the digest (and 65-byte + 0x00 is invalid per BIP341)
    expect(verifyBip322Simple(BIP322_P2TR, 'mainnet', 'Hello World', flipBase64Byte(V.p2trHello, 66)).valid).toBe(false);
    // DER r, s and pubkey tampering on P2WPKH
    for (const i of [8, 30, 40, 70, 74]) {
      expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', 'Hello World', flipBase64Byte(V.p2wpkhHello, i)).valid).toBe(false);
    }
  });

  it('mainnet vectors are rejected on testnet (address network binding)', () => {
    expect(verifyBip322Simple(BIP322_P2WPKH, 'testnet', 'Hello World', V.p2wpkhHello)).toMatchObject({ valid: false });
  });
});

describe('sighash cross-check against @scure/btc-signer', () => {
  // Rebuild to_sign with btc-signer and compare its BIP143 / BIP341 preimage digests with ours.
  function toSign(script: Uint8Array, message: string): Transaction {
    const { toSpendTxid } = bip322VirtualTxids(script, message);
    const tx = new Transaction({ version: 0, allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    tx.addInput({ txid: hex.decode(txidHex(toSpendTxid)), index: 0, sequence: 0 });
    tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
    return tx;
  }

  it.each(['', 'Hello World', 'x'.repeat(300)])('P2WPKH BIP143 digest (%#)', (msg) => {
    const d = decodeAddress(BIP322_P2WPKH, 'mainnet');
    const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), d.program, Uint8Array.of(0x88, 0xac));
    const theirs = toSign(d.script, msg).preimageWitnessV0(0, scriptCode, 1, 0n);
    expect(hex.encode(bip322SighashP2wpkh(d.program, msg))).toBe(hex.encode(theirs));
  });

  it.each([0, 1])('P2TR BIP341 key-path digest (hashType %i)', (hashType) => {
    const d = decodeAddress(BIP322_P2TR, 'mainnet');
    const theirs = toSign(d.script, 'Hello World').preimageWitnessV1(0, [d.script], hashType, [0n]);
    expect(hex.encode(bip322SighashP2tr(d.program, 'Hello World', hashType))).toBe(hex.encode(theirs));
  });
});

describe('reference signer round-trips', () => {
  const nets = ['mainnet', 'testnet', 'signet', 'regtest'] as const;
  it.each(nets)('P2TR SIGHASH_DEFAULT and SIGHASH_ALL on %s', (net) => {
    const a = addr('tr', key(11), net);
    const s0 = signBip322Simple(key(11), 'p2tr', 'sign me');
    const s1 = signBip322Simple(key(11), 'p2tr', 'sign me', { hashType: 1 });
    expect(Buffer.from(s0, 'base64').length).toBe(66);
    expect(Buffer.from(s1, 'base64').length).toBe(67);
    expect(verifyBip322Simple(a, net, 'sign me', s0).valid).toBe(true);
    expect(verifyBip322Simple(a, net, 'sign me', s1).valid).toBe(true);
    expect(verifyBip322Simple(a, net, 'sign me.', s0).valid).toBe(false);
  });

  it.each(nets)('P2WPKH on %s', (net) => {
    const a = addr('wpkh', key(12), net);
    const s = signBip322Simple(key(12), 'p2wpkh', 'sign me');
    expect(verifyBip322Simple(a, net, 'sign me', s).valid).toBe(true);
    expect(verifyBip322Simple(addr('wpkh', key(13), net), net, 'sign me', s).valid).toBe(false);
  });

  it('reproduces the BIP-322 key\'s P2WPKH address check with our own signature', () => {
    const s = signBip322Simple(BIP322_PRIV, 'p2wpkh', 'Hello World');
    expect(verifyBip322Simple(BIP322_P2WPKH, 'mainnet', 'Hello World', s).valid).toBe(true);
  });

  it('binary messages are signed as raw bytes', () => {
    const msg = Uint8Array.of(0, 1, 2, 255);
    const s = signBip322Simple(key(14), 'p2tr', msg);
    expect(verifyBip322Simple(addr('tr', key(14)), 'mainnet', msg, s).valid).toBe(true);
  });
});

describe('malformed and hostile signatures', () => {
  const a = addr('wpkh', key(21));
  const good = signBip322Simple(key(21), 'p2wpkh', 'm');
  const w = decodeWitness(Buffer.from(good, 'base64'));
  const enc = (items: Uint8Array[]) => encodeBase64(encodeWitness(items));

  it('rejects non-base64 and empty input without throwing', () => {
    expect(verifyBip322Simple(a, 'mainnet', 'm', '!!!').valid).toBe(false);
    expect(verifyBip322Simple(a, 'mainnet', 'm', '').valid).toBe(false);
    expect(verifyBip322Simple('not-an-address', 'mainnet', 'm', good).valid).toBe(false);
  });

  it('rejects trailing bytes and truncated witnesses', () => {
    const raw = Buffer.from(good, 'base64');
    expect(verifyBip322Simple(a, 'mainnet', 'm', Buffer.concat([raw, Buffer.of(0)]).toString('base64')).valid).toBe(false);
    expect(verifyBip322Simple(a, 'mainnet', 'm', raw.subarray(0, raw.length - 1).toString('base64')).valid).toBe(false);
  });

  it('rejects wrong witness shapes', () => {
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([w[0]!])).valid).toBe(false);
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([w[0]!, w[1]!, new Uint8Array(1)])).valid).toBe(false);
    const t = addr('tr', key(22));
    const tw = decodeWitness(Buffer.from(signBip322Simple(key(22), 'p2tr', 'm'), 'base64'));
    expect(verifyBip322Simple(t, 'mainnet', 'm', enc(tw)).valid).toBe(true);
    // annex / script-path shapes are refused
    expect(verifyBip322Simple(t, 'mainnet', 'm', enc([tw[0]!, Uint8Array.of(0x50)])).valid).toBe(false);
    // 65-byte with SIGHASH_NONE
    expect(verifyBip322Simple(t, 'mainnet', 'm', enc([concatBytes(tw[0]!, Uint8Array.of(2))])).valid).toBe(false);
  });

  it('rejects non-SIGHASH_ALL and uncompressed pubkeys for P2WPKH', () => {
    const sig = w[0]!;
    const none = concatBytes(sig.subarray(0, sig.length - 1), Uint8Array.of(0x02));
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([none, w[1]!])).valid).toBe(false);
    const unc = secp256k1.getPublicKey(key(21), false);
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([sig, unc])).valid).toBe(false);
  });

  it('rejects high-S (malleated) ECDSA signatures', () => {
    const digest = bip322SighashP2wpkh(hash160(secp256k1.getPublicKey(key(21), true)), 'm');
    const low = secp256k1.Signature.fromBytes(secp256k1.sign(digest, key(21), { prehash: false }), 'compact');
    const high = new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s);
    const der = concatBytes(high.toBytes('der'), Uint8Array.of(1));
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([der, w[1]!])).valid).toBe(false);
    const derLow = concatBytes(low.toBytes('der'), Uint8Array.of(1));
    expect(verifyBip322Simple(a, 'mainnet', 'm', enc([derLow, w[1]!])).valid).toBe(true);
  });

  it('refuses BIP-322 simple for legacy P2PKH addresses', () => {
    expect(verifyBip322Simple(addr('pkh', key(21)), 'mainnet', 'm', good)).toMatchObject({ valid: false });
  });
});
