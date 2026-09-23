import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import { networkParams } from '@bsh/inscription';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { api, browserCreate, browserMintToPayment, browserUpload, FakeArtReview, makeHarness, regtestAddress, standardArt } from './fakes/harness.js';
import { png } from './fakes/images.js';

function validBody(overrides: Record<string, unknown> = {}) {
  const bytes = standardArt();
  return {
    tier: 'standard',
    contentType: 'image/png',
    contentLength: bytes.length,
    contentSha256: sha256Hex(bytes),
    recipientAddress: regtestAddress(9),
    revealPubkey: bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    feeRate: 2,
    ...overrides,
  };
}

describe('read endpoints', () => {
  it('GET /v1/health', async () => {
    const h = makeHarness();
    await h.ready;
    const r = await api(h, 'GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', network: 'regtest', checks: { store: { ok: true }, chain: { ok: true }, parent: { ok: true } } });
    h.chain.down = true;
    expect((await api(h, 'GET', '/v1/health')).body.status).toBe('degraded');
  });

  it('GET /v1/config exposes rules and addresses, no secrets', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', '/v1/config');
    expect(r.status).toBe(200);
    expect(r.body.tiers).toHaveLength(2);
    expect(r.body.collectionAddress).toBe(h.signer.collectionAddress());
    expect(r.body.maxUploadBytes).toBe(4 * 1024 * 1024);
    expect(JSON.stringify(r.body)).not.toMatch(/key|secret|token/i);
  });

  it('GET /v1/fees clamps to the minimum fee rate', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', '/v1/fees');
    expect(r.body).toMatchObject({ network: 'regtest', minFeeRate: 1, standard: { slow: 1, normal: 2, fast: 5 }, block: { min: 1, recommended: 3 } });
  });

  it('GET /v1/queue', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', '/v1/queue');
    expect(r.body).toMatchObject({ standard: { waiting: 0, inFlight: 0, capacity: 3 }, block: { capacity: 1, etaMinutesForNext: 10 }, tipHeight: 100 });
  });

  it('unknown routes and orders are structured 404s', async () => {
    const h = makeHarness();
    expect((await api(h, 'GET', '/v1/nope')).body.error.code).toBe('not_found');
    const r = await api(h, 'GET', '/v1/orders/dgt_missing');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    expect((await api(h, 'GET', '/v1/orders/..%2F..%2Fetc')).status).toBe(404);
  });
});

describe('POST /v1/orders', () => {
  it('creates an order with an indicative quote and a one-time token', async () => {
    const h = makeHarness();
    const r = await api(h, 'POST', '/v1/orders', { json: validBody() });
    expect(r.status).toBe(201);
    expect(r.body.orderToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const o = r.body.order;
    expect(o.status).toBe('awaiting_content');
    expect(o.quote).toMatchObject({ binding: false, commitAddress: null, lane: 'standard', feeRate: 2, postageSats: 546 });
    expect(o.quote.commitValueSats).toBe(o.quote.revealFeeSats + 546);
    // token is never stored in clear nor readable back
    const again = await api(h, 'GET', `/v1/orders/${o.id}`);
    expect(JSON.stringify(again.body)).not.toContain(r.body.orderToken);
    expect(JSON.stringify(await h.store.get(o.id))).not.toContain(r.body.orderToken);
  });

  it.each([
    ['sha256 not hex', { contentSha256: 'xyz' }, 'contentSha256'],
    ['tier/size mismatch', { tier: 'block' }, 'collection rules'],
    ['size below the standard tier', { contentLength: 1000 }, 'collection rules'],
    ['size above the block tier', { tier: 'block', contentLength: 3_900_001 }, 'collection rules'],
    ['disallowed type', { contentType: 'image/svg+xml' }, 'collection rules'],
    ['fee below the minimum', { feeRate: 0.5 }, 'feeRate must be >='],
    ['absurd fee', { feeRate: 5000 }, 'feeRate must be <='],
    ['mainnet address on regtest', { recipientAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr' }, 'not a valid regtest address'],
    ['testnet address on regtest', { recipientAddress: 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c' }, 'not a valid regtest address'],
    ['non-taproot recipient', { recipientAddress: p2wpkh(new Uint8Array(33).fill(2), networkParams('regtest')).address }, 'taproot'],
    ['invalid x-only pubkey', { revealPubkey: 'f'.repeat(64) }, 'x-only point'],
    ['unknown field', { memo: 'hi' }, 'unknown field'],
  ])('rejects %s', async (_n, override, message) => {
    const h = makeHarness();
    const r = await api(h, 'POST', '/v1/orders', { json: validBody(override) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.message).toContain(message);
  });

  it('rejects non-JSON, wrong content type and oversize bodies', async () => {
    const h = makeHarness();
    expect((await h.app.request('/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await api(h, 'POST', '/v1/orders', { json: validBody(), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    const big = await api(h, 'POST', '/v1/orders', { json: { ...validBody(), pad: 'x'.repeat(20_000) } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('payload_too_large');
  });

  it('testnet addresses are fine on testnet', () => {
    expect(TEST_NETWORK.bech32).toBe('tb');
  });
});

describe('order token (401 / 403)', () => {
  it('PUT /content, POST /reveal and GET /rescue require the bearer token', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const other = await browserCreate(h);
    const reveal = { commitTxid: 'a'.repeat(64), commitVout: 0, halfSignedRevealPsbt: 'cHNidP8=' };
    for (const [method, path, init] of [
      ['PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes }],
      ['POST', `/v1/orders/${b.orderId}/reveal`, { json: reveal }],
      ['GET', `/v1/orders/${b.orderId}/rescue`, {}],
    ] as const) {
      const none = await api(h, method, path, init);
      expect(none.status).toBe(401);
      expect(none.body.error.code).toBe('unauthorized');
      const wrong = await api(h, method, path, { ...init, token: other.token });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('forbidden');
      const garbage = await api(h, method, path, { ...init, headers: { authorization: 'Basic abc' } });
      expect(garbage.status).toBe(401);
    }
    expect((await api(h, 'GET', `/v1/orders/${b.orderId}`)).body.status).toBe('awaiting_content');
  });
});

describe('PUT /v1/orders/{id}/content', () => {
  it('validates bytes, reviews, and returns the binding quote', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const indicative = b.order.quote!;
    const o = await browserUpload(h, b);
    expect(o.status).toBe('approved');
    expect(o.quote).toMatchObject({ binding: true, commitAddress: expect.stringMatching(/^bcrt1p/) });
    // weight depends only on length: indicative == binding
    expect(o.quote!.revealWeight).toBe(indicative.revealWeight);
    expect(o.quote!.commitValueSats).toBe(indicative.commitValueSats);
    expect(o.review!.approved).toBe(true);
    expect(await h.content.has(b.order.contentSha256)).toBe(true);
    // second upload conflicts
    const again = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token });
    expect(again.status).toBe(409);
  });

  it('rejects wrong length and wrong content-type header', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const short = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes.slice(1), token: b.token });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('content_mismatch');
    const ct = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token, headers: { 'content-type': 'image/png' } });
    expect(ct.status).toBe(415);
  });

  it('bytes whose real type differs from the declared type are rejected by review', async () => {
    const h = makeHarness();
    await h.ready;
    const gifBytes = standardArt();
    gifBytes.set(new TextEncoder().encode('GIF89a'), 0); // no longer a PNG
    const b = await browserCreate(h, { bytes: gifBytes });
    const o = await browserUpload(h, b);
    expect(o.status).toBe('rejected');
    expect(o.review!.reasons.join(' ')).toContain('image/gif');
    expect(await h.content.has(b.order.contentSha256)).toBe(false);
  });

  it('dimension violations are rejected before payment', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h, { bytes: png(5000, 1000, 200_000) });
    expect((await browserUpload(h, b)).status).toBe('rejected');
  });

  it('reviewer outage -> 503 and the upload can be retried', async () => {
    const review = new FakeArtReview(new Error('vision API down'));
    const h = makeHarness({ review });
    await h.ready;
    const b = await browserCreate(h);
    const r = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('review_unavailable');
    expect(r.body.error.message).not.toContain('vision API down');
    review.result = { approved: true, reasons: [], checks: [] };
    expect((await browserUpload(h, b)).status).toBe('approved');
  });

  it('expired orders refuse content', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    h.clock.advance(901);
    const r = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('quote_expired');
  });

  it('enforces the 4 MB upload limit', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const r = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: new Uint8Array(4 * 1024 * 1024 + 1), token: b.token });
    expect(r.status).toBe(413);
  });
});

describe('POST /v1/orders/{id}/reveal', () => {
  it('stores the verified reveal encrypted, outside the order row, and never returns it', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    expect(b.order.status).toBe('awaiting_payment');
    expect(b.order.commitOutpoint).toEqual({ txid: b.commitTxid, vout: 0 });
    const row = JSON.stringify(await h.store.get(b.orderId));
    expect(row).not.toContain(b.psbt!.slice(0, 64));
    const blob = h.blobs.blobs.get(b.orderId)!;
    expect(Buffer.from(blob).toString('latin1')).not.toContain(b.psbt!.slice(0, 64));
    expect(await h.reveals.get(b.orderId)).toBe(b.psbt);
    const pub = await api(h, 'GET', `/v1/orders/${b.orderId}`);
    expect(JSON.stringify(pub.body)).not.toContain(b.psbt!.slice(0, 64));
    expect(pub.body).not.toHaveProperty('orderTokenHash');
    expect(pub.body).not.toHaveProperty('hasReveal');
  });

  it('rejects malformed bodies, wrong status and a mismatched commit address', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserCreate(h);
    const early = await api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, {
      json: { commitTxid: 'a'.repeat(64), commitVout: 0, halfSignedRevealPsbt: 'cHNidP8=' },
      token: b.token,
    });
    expect(early.status).toBe(409);
    await browserUpload(h, b);
    const bad = await api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, { json: { commitTxid: 'zz', commitVout: -1, halfSignedRevealPsbt: '%%' }, token: b.token });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors).toHaveLength(3);
    const addr = await api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, {
      json: { commitTxid: 'a'.repeat(64), commitVout: 0, halfSignedRevealPsbt: 'cHNidP8=', commitAddress: regtestAddress(3) },
      token: b.token,
    });
    expect(addr.status).toBe(422);
    expect(addr.body.error.code).toBe('reveal_invalid');
    const junk = await api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, {
      json: { commitTxid: 'a'.repeat(64), commitVout: 0, halfSignedRevealPsbt: 'cHNidP8=' },
      token: b.token,
    });
    expect(junk.status).toBe(422);
    expect(junk.body.error.code).toBe('reveal_invalid');
  });

  it('GET /rescue is 409 until rescue_available', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    const r = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'rescue_unavailable', details: { status: 'awaiting_payment' } });
  });
});

describe('cross-cutting', () => {
  it('CORS: allowlisted origin gets headers; others get none and cannot mutate', async () => {
    const h = makeHarness({ corsOrigins: ['https://degent.club'] });
    const ok = await h.app.request('/v1/config', { headers: { origin: 'https://degent.club' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://degent.club');
    const evil = await h.app.request('/v1/config', { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const post = await api(h, 'POST', '/v1/orders', { json: validBody(), headers: { origin: 'https://evil.example' } });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('forbidden_origin');
    const pre = await h.app.request('/v1/orders', { method: 'OPTIONS', headers: { origin: 'https://degent.club', 'access-control-request-method': 'POST' } });
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('CORS default is deny-all', async () => {
    const h = makeHarness({ corsOrigins: [] });
    const r = await h.app.request('/v1/config', { headers: { origin: 'https://degent.club' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('per-IP rate limit on POST/PUT, GETs unaffected', async () => {
    const h = makeHarness({ rateLimit: { windowMs: 60_000, max: 2 } });
    const post = (ip: string) => api(h, 'POST', '/v1/orders', { json: validBody(), headers: { 'x-test-ip': ip } });
    expect((await post('1.1.1.1')).status).toBe(201);
    expect((await post('1.1.1.1')).status).toBe(201);
    const limited = await post('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await post('2.2.2.2')).status).toBe(201);
    expect((await api(h, 'GET', '/v1/config', { headers: { 'x-test-ip': '1.1.1.1' } })).status).toBe(200);
    h.clock.advance(61);
    expect((await post('1.1.1.1')).status).toBe(201);
  });

  it('security headers on every response', async () => {
    const h = makeHarness();
    const r = await h.app.request('/v1/health');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('block lane refuses new orders when the queue would outlast the rescue timeout', async () => {
    const h = makeHarness({ settings: { collection: { ...makeHarness().settings.collection, rescueAfterSeconds: 700 } } });
    const big = png(1000, 1000, 400_000);
    const body = validBody({ tier: 'block', contentLength: big.length, contentSha256: sha256Hex(big) });
    const r = await api(h, 'POST', '/v1/orders', { json: body });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('queue_full');
  });
});
