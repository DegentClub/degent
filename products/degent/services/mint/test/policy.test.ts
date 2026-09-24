/** The parent co-signing policy against real PSBTs built by @bsh/inscription. */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { addressToScript, attachParent, buildHalfSignedReveal, commitAddress } from '@bsh/inscription';
import { InMemoryPolicySigner } from '../src/adapters/in-memory-policy-signer.js';
import { PolicyViolation } from '../src/domain/errors.js';
import { DEFAULT_POLICY, evaluateParentPolicy, type PolicyContext } from '../src/domain/policy.js';
import { fakeTxid, NET, PARENT_KEY, regtestAddress } from './fakes/harness.js';

const signer = new InMemoryPolicySigner(PARENT_KEY, NET, DEFAULT_POLICY, { warn: () => {} });
const collectionScript = addressToScript(signer.collectionAddress(), NET);

function build(opts: { feeRate?: number } = {}) {
  const revealKey = new Uint8Array(32).fill(5);
  const content = { contentType: 'image/png', body: new Uint8Array(1000).fill(1), parentId: `${fakeTxid(0)}i0` };
  const commit = commitAddress(schnorr.getPublicKey(revealKey), content, NET);
  const recipient = regtestAddress(4);
  const weight = 5000; // pretend quote weight
  const fee = BigInt(Math.ceil((weight / 4) * (opts.feeRate ?? 2)));
  const commitOutpoint = { txid: fakeTxid(1), vout: 0 };
  const half = buildHalfSignedReveal({
    network: NET, revealPrivkey: revealKey, content, commitOutpoint, commitValue: fee + 546n, recipientAddress: recipient, postage: 546n,
    parentReturnAddress: signer.collectionAddress(), parentValue: 10_000n, // 0x81 (ADR-0005): output 0 signed up front
  });
  const parentOutpoint = { txid: fakeTxid(2), vout: 0 };
  const attached = attachParent({ network: NET, halfSignedPsbtBase64: half.psbtBase64, parentOutpoint, parentValue: 10_000n, parentScript: collectionScript, parentReturnAddress: signer.collectionAddress() });
  const ctx: PolicyContext = {
    lane: 'standard',
    parentOutpoint,
    parentValue: 10_000n,
    parentScript: collectionScript,
    collectionScript,
    commitOutpoint,
    commitValue: fee + 546n,
    commitScript: commit.script,
    recipientScript: addressToScript(recipient, NET),
    postage: 546n,
    quotedFeeRate: 2,
    expectedWeight: weight,
  };
  return { psbt: attached.psbtBase64, ctx };
}

function mutate(psbt: string, fn: (tx: Transaction) => void): string {
  const tx = Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true });
  fn(tx);
  return base64.encode(tx.toPSBT());
}

describe('evaluateParentPolicy', () => {
  it('accepts the exact ADR-0002 §3 shape', () => {
    const { psbt, ctx } = build();
    expect(evaluateParentPolicy(psbt, ctx)).toEqual([]);
  });

  it('the checks are unchanged under 0x81: a parent whose value differs from the signed output 0 is refused', () => {
    // The browser signed output 0 = 10,000 sats. A 12,000-sat parent would move the child's sat.
    const { psbt, ctx } = build();
    expect(evaluateParentPolicy(psbt, { ...ctx, parentValue: 12_000n }).join('\n')).toMatch(/input 0 value differs|output 0 value must equal/);
  });

  it.each<[string, (c: PolicyContext) => PolicyContext, RegExp]>([
    ['another parent outpoint', (c) => ({ ...c, parentOutpoint: { txid: fakeTxid(9), vout: 0 } }), /input 0 is not the leased parent/],
    ['another commit outpoint', (c) => ({ ...c, commitOutpoint: { txid: fakeTxid(9), vout: 0 } }), /input 1 is not this order/],
    ['another commit script', (c) => ({ ...c, commitScript: collectionScript }), /commit script/],
    ['another recipient', (c) => ({ ...c, recipientScript: addressToScript(regtestAddress(5), NET) }), /does not pay the order recipient/],
    ['another collection address', (c) => ({ ...c, collectionScript: addressToScript(regtestAddress(6), NET) }), /return the parent/],
    ['different postage', (c) => ({ ...c, postage: 600n }), /postage differs/],
    ['fee far from the quote', (c) => ({ ...c, quotedFeeRate: 4 }), /deviates/],
    ['over the lane weight', (c) => ({ ...c, expectedWeight: 400_004 }), /exceeds the standard lane/],
  ])('refuses %s', (_n, change, re) => {
    const { psbt, ctx } = build();
    expect(evaluateParentPolicy(psbt, change(ctx)).join('\n')).toMatch(re);
  });

  it('refuses extra outputs (which 0x81 already makes unsignable) and garbage', () => {
    const { psbt, ctx } = build();
    // ADR-0005: with SIGHASH_ALL|ANYONECANPAY the outputs are signed; the PSBT library refuses to add one.
    expect(() => mutate(psbt, (tx) => tx.addOutput({ script: collectionScript, amount: 1000n }))).toThrow(/signed outputs/);
    // The policy still states the shape independently: an unsigned 3-output PSBT is refused before anything else.
    const three = new Transaction({ allowUnknownInputs: true });
    three.addInput({ txid: hex.decode(ctx.parentOutpoint.txid), index: 0, witnessUtxo: { script: collectionScript, amount: 10_000n } });
    three.addInput({ txid: hex.decode(ctx.commitOutpoint.txid), index: 0, witnessUtxo: { script: ctx.commitScript, amount: ctx.commitValue } });
    three.addOutput({ script: collectionScript, amount: 10_000n });
    three.addOutput({ script: ctx.recipientScript, amount: 546n });
    three.addOutput({ script: collectionScript, amount: 1000n });
    expect(evaluateParentPolicy(base64.encode(three.toPSBT()), ctx).join()).toMatch(/exactly 2 outputs/);
    expect(evaluateParentPolicy('not-a-psbt', ctx)[0]).toMatch(/unparseable/);
  });

  it('refuses a fee rate outside the lane band', () => {
    const { psbt, ctx } = build({ feeRate: 2 });
    const cfg = { ...DEFAULT_POLICY, bands: { ...DEFAULT_POLICY.bands, standard: { minFeeRate: 3, maxFeeRate: 10 } } };
    expect(evaluateParentPolicy(psbt, ctx, cfg).join()).toMatch(/outside the standard band/);
  });
});

describe('InMemoryPolicySigner', () => {
  it('signs input 0 only when the policy passes', async () => {
    const { psbt, ctx } = build();
    const { collectionScript: _omit, ...context } = ctx;
    const signed = await signer.sign({ orderId: 'o', psbtBase64: psbt, context });
    const tx = Transaction.fromPSBT(base64.decode(signed.psbtBase64), { allowUnknownInputs: true });
    expect(tx.getInput(0).tapKeySig).toHaveLength(64);
    await expect(signer.sign({ orderId: 'o', psbtBase64: psbt, context: { ...context, postage: 330n } })).rejects.toBeInstanceOf(PolicyViolation);
    expect(hex.encode(collectionScript).startsWith('5120')).toBe(true);
  });
});
