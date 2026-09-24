/** @bsh/degent-mint-sdk typed client against the real Hono app through a fetch shim. */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildHalfSignedReveal } from '@bsh/inscription';
import { ApiError, createMintClient, sha256Hex } from '@bsh/degent-mint-sdk';
import { fakeTxid, makeHarness, NET, regtestAddress, standardArt } from './fakes/harness.js';

function clientFor(h: ReturnType<typeof makeHarness>) {
  return createMintClient({
    baseUrl: 'https://mint.degent.club',
    fetch: (url, init) => Promise.resolve(h.app.request(new URL(url).pathname, init)),
  });
}

describe('mint-sdk client <-> service', () => {
  it('drives a whole order through every endpoint', async () => {
    const h = makeHarness();
    await h.ready;
    const c = clientFor(h);
    expect((await c.health()).status).toBe('ok');
    expect((await c.config()).collectionAddress).toBe(h.signer.collectionAddress());
    expect((await c.fees()).standard.normal).toBe(2);
    expect((await c.queue()).block.capacity).toBe(1);

    const bytes = standardArt();
    const key = schnorr.utils.randomSecretKey();
    const recipientAddress = regtestAddress(8);
    const { order, orderToken } = await c.createOrder({
      tier: 'standard',
      contentType: 'image/png',
      contentLength: bytes.length,
      contentSha256: sha256Hex(bytes),
      recipientAddress,
      revealPubkey: bytesToHex(schnorr.getPublicKey(key)),
      feeRate: 3,
    });
    const approved = await c.uploadContent(order.id, orderToken, bytes);
    expect(approved.status).toBe('approved');
    const commitTxid = fakeTxid(5);
    const { psbtBase64 } = buildHalfSignedReveal({
      network: NET,
      revealPrivkey: key,
      content: { contentType: 'image/png', body: bytes, parentId: h.settings.collection.parentInscriptionId! },
      commitOutpoint: { txid: commitTxid, vout: 0 },
      commitValue: BigInt(approved.quote!.commitValueSats),
      recipientAddress,
      postage: 546n,
      parentReturnAddress: approved.quote!.parentReturnAddress,
      parentValue: BigInt(approved.quote!.parentValueSats!),
    });
    const paying = await c.submitReveal(order.id, orderToken, { commitTxid, commitVout: 0, halfSignedRevealPsbt: psbtBase64 });
    expect(paying.status).toBe('awaiting_payment');
    expect((await c.getOrder(order.id)).status).toBe('awaiting_payment');

    const err = await c.getRescue(order.id, orderToken).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'rescue_unavailable' });
    const forbidden = await c.getRescue(order.id, 'x'.repeat(43)).catch((e) => e);
    expect(forbidden).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('surfaces validation errors as ApiError with details', async () => {
    const h = makeHarness();
    const c = clientFor(h);
    const e = await c
      .createOrder({ tier: 'standard', contentType: 'image/png', contentLength: 5, contentSha256: 'a'.repeat(64), recipientAddress: 'x', revealPubkey: 'y', feeRate: 1 })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(422);
    expect(e.code).toBe('validation_failed');
  });
});
