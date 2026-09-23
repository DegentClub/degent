import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import {
  buildHalfSignedReveal,
  commitAddress,
  NUMS_INTERNAL_KEY,
  REVEAL_SEQUENCE,
  verifyHalfSignedReveal,
} from '../src/index.js';
import { COMMIT_OUTPOINT, content, NETWORK, PARENT, POSTAGE, RECIPIENT, REVEAL_PRIV, REVEAL_PUB } from './helpers.js';

const OPTS = { allowUnknownInputs: true } as const;
const COMMIT_VALUE = 50_000n;
const c = content(3000);
const half = buildHalfSignedReveal({
  network: NETWORK,
  revealPrivkey: REVEAL_PRIV,
  content: c,
  commitOutpoint: COMMIT_OUTPOINT,
  commitValue: COMMIT_VALUE,
  recipientAddress: RECIPIENT.address!,
  postage: POSTAGE,
});
const good = {
  network: NETWORK,
  psbtBase64: half.psbtBase64,
  revealPubkey: REVEAL_PUB,
  content: c,
  expectedCommitOutpoint: COMMIT_OUTPOINT,
  expectedCommitValue: COMMIT_VALUE,
  expectedRecipientAddress: RECIPIENT.address!,
  expectedPostage: POSTAGE,
};
const reason = (r: ReturnType<typeof verifyHalfSignedReveal>) => (r.ok ? 'ok' : r.reason);

/** Same construction as buildHalfSignedReveal, but with an arbitrary sighash type. */
function signedWith(sighash: number): string {
  const commit = commitAddress(REVEAL_PUB, c, NETWORK);
  const tx = new Transaction({ version: 2, ...OPTS });
  tx.addOutput({ script: RECIPIENT.script, amount: POSTAGE });
  tx.addInput({
    txid: COMMIT_OUTPOINT.txid,
    index: COMMIT_OUTPOINT.vout,
    sequence: REVEAL_SEQUENCE,
    witnessUtxo: { script: commit.script, amount: COMMIT_VALUE },
    tapInternalKey: NUMS_INTERNAL_KEY,
    tapLeafScript: [[{ version: commit.controlBlock[0]!, internalKey: NUMS_INTERNAL_KEY, merklePath: [] }, new Uint8Array([...commit.leafScript, 0xc0])]],
    sighashType: sighash,
  });
  tx.signIdx(REVEAL_PRIV, 0, [sighash]);
  return base64.encode(tx.toPSBT());
}

describe('verifyHalfSignedReveal', () => {
  it('accepts the genuine half-signed reveal', () => {
    expect(verifyHalfSignedReveal(good)).toEqual({ ok: true });
  });

  it('rejects wrong content (one byte different)', () => {
    const body = Uint8Array.from(c.body);
    body[100] = body[100]! ^ 1;
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, body } }))).toMatch(/commit scriptPubKey mismatch/);
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, contentType: 'image/png' } }))).toMatch(/mismatch/);
    expect(reason(verifyHalfSignedReveal({ ...good, content: { ...c, parentId: undefined } }))).toMatch(/mismatch/);
  });

  it('rejects wrong reveal key', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, revealPubkey: PARENT.tweakedPubkey }))).not.toBe('ok');
  });

  it('rejects wrong recipient', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedRecipientAddress: PARENT.address! }))).toMatch(/recipient/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedRecipientAddress: 'not-an-address' }))).toMatch(/recipient/);
  });

  it('rejects wrong postage', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedPostage: POSTAGE + 1n }))).toMatch(/postage/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedPostage: 329n }))).toMatch(/dust/);
  });

  it('rejects wrong commit outpoint and value', () => {
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitOutpoint: { ...COMMIT_OUTPOINT, vout: 0 } }))).toMatch(/outpoint/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitOutpoint: { txid: 'ab'.repeat(32), vout: 1 } }))).toMatch(/outpoint/);
    expect(reason(verifyHalfSignedReveal({ ...good, expectedCommitValue: COMMIT_VALUE + 1n }))).toMatch(/commit value/);
  });

  it('rejects wrong sighash type (0x81, 0x01, DEFAULT)', () => {
    for (const sh of [0x81, 0x01, 0x00]) {
      const psbt = signedWith(sh);
      expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: psbt }))).toMatch(/0x83|65 bytes/);
    }
    // A 0x83 PSBT built the same way is accepted, proving the helper is otherwise faithful.
    expect(verifyHalfSignedReveal({ ...good, psbtBase64: signedWith(0x83) })).toEqual({ ok: true });
  });

  it('rejects a forged signature', () => {
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    const [[key, sig]] = tx.getInput(0).tapScriptSig! as [[{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array]];
    const bad = Uint8Array.from(sig);
    bad[10] = bad[10]! ^ 1;
    // rebuild the PSBT with the forged signature in place of the genuine one
    const inp = tx.getInput(0);
    const fresh = new Transaction({ version: 2, ...OPTS });
    fresh.addOutput(tx.getOutput(0) as { script: Uint8Array; amount: bigint });
    fresh.addInput({ ...inp, tapScriptSig: [[key, bad]] });
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(fresh.toPSBT()) }))).toMatch(/does not verify/);
  });

  it('rejects extra inputs/outputs and garbage', () => {
    const tx = Transaction.fromPSBT(base64.decode(half.psbtBase64), OPTS);
    tx.addOutput({ script: PARENT.script, amount: 1000n }, true);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: base64.encode(tx.toPSBT()) }))).toMatch(/1 output/);
    expect(reason(verifyHalfSignedReveal({ ...good, psbtBase64: 'bm90IGEgcHNidA==' }))).toMatch(/decode/);
    expect(reason(verifyHalfSignedReveal({ ...good, network: 'mainnet' }))).not.toBe('ok');
  });
});
