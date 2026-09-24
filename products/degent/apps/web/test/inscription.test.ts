/**
 * The real InscriptionOps adapter (services/real/inscription.ts) against @bsh/inscription itself: the browser's
 * half-signed reveal is SIGHASH_ALL|ANYONECANPAY over [parent return, child] and passes the service-side
 * verification; the re-signed rescue spends the same commit to the recipient only (ADR-0005).
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildRescueReveal, networkParams, verifyHalfSignedReveal } from '@bsh/inscription';
import { createRealInscription } from '../src/services/real/inscription';

const NET = 'regtest' as const;
const addr = (seed: number) => btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(seed)), undefined, networkParams(NET)).address!;

describe('real inscription adapter (ADR-0005)', () => {
  const ops = createRealInscription();
  const key = ops.generateEphemeralKey();
  const content = { contentType: 'image/webp', body: new Uint8Array(2_000).fill(3), parentId: `${'ab'.repeat(32)}i0` };
  const commitOutpoint = { txid: 'cd'.repeat(32), vout: 0 };
  const recipient = addr(4);
  const collection = addr(7);

  it('signs 0x81 over [parent return, child]; the service-side verification accepts exactly that', () => {
    const { psbtBase64 } = ops.buildHalfSignedReveal({
      network: NET,
      revealPrivkey: key.privkey,
      content,
      commitOutpoint,
      commitValue: 20_000n,
      recipientAddress: recipient,
      postage: 546n,
      parentReturnAddress: collection,
      parentValue: 10_000n,
    });
    const common = {
      network: NET,
      psbtBase64,
      revealPubkey: hex.decode(key.pubkeyHex),
      content,
      expectedCommitOutpoint: commitOutpoint,
      expectedCommitValue: 20_000n,
      expectedRecipientAddress: recipient,
      expectedPostage: 546n,
    };
    expect(verifyHalfSignedReveal({ ...common, expectedParentReturnAddress: collection, expectedParentValue: 10_000n })).toEqual({ ok: true });
    expect(verifyHalfSignedReveal({ ...common, expectedParentReturnAddress: collection, expectedParentValue: 10_001n }).ok).toBe(false);
    expect(verifyHalfSignedReveal({ ...common, expectedSighash: 'single_anyonecanpay' }).ok).toBe(false);
    // A 0x81 reveal that pre-committed the parent return is not replayable as a rescue.
    expect(() => buildRescueReveal({ network: NET, halfSignedPsbtBase64: psbtBase64 })).toThrow();
  });

  it('re-signs [commit] -> [child] with K_e for the rescue', () => {
    const tx = ops.buildResignedRescue({
      network: NET,
      revealPrivkey: key.privkey,
      content,
      commitOutpoint,
      commitValue: 20_000n,
      recipientAddress: recipient,
      postage: 546n,
      feeRate: 2,
    });
    const parsed = btc.Transaction.fromRaw(hex.decode(tx.hex), { allowUnknownOutputs: true, disableScriptCheck: true });
    expect([parsed.inputsLength, parsed.outputsLength]).toEqual([1, 1]);
    expect(hex.encode(parsed.getInput(0).txid!)).toBe(commitOutpoint.txid);
    expect(parsed.getOutput(0).amount).toBe(546n);
    expect(tx.fee).toBe(20_000n - 546n);
    expect(ops.publicKeyHex(key.privkey)).toBe(key.pubkeyHex);
  });
});
