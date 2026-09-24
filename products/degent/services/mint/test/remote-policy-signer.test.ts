/**
 * p5.1: SIGNER=remote. The mint -> RemoteSignerClient -> platform signer service path runs for real (the
 * signer app, its policies from the operator config in RUNBOOK §7, an in-memory key provider holding the
 * collection key). The mint's own ADR-0002 §3 policy still runs first and refuses before any network call.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { addressToScript } from '@bsh/inscription';
import { InMemoryKeyProvider } from '@bsh/signer';
import type { Order } from '@bsh/degent-mint-sdk';
import { RemotePolicySigner, RemoteSignerFailure } from '../src/adapters/remote-policy-signer.js';
import { PolicyViolation } from '../src/domain/errors.js';
import { MintWorker } from '../src/worker.js';
import type { PolicySigner, PolicySignRequest } from '../src/ports/policy-signer.js';
import { api, browserMintToPayment, fundCommit, makeHarness, NET, PARENT_KEY, type Harness } from './fakes/harness.js';
import { FlakyKeyProvider, makeSignerService, maxFeeSatsFor, SIGNER_KEY_ID, SIGNER_URL } from './fakes/remote-signer.js';

const noSleep = async () => {};

function remoteFor(h: Harness, svc: ReturnType<typeof makeSignerService>, o: { retries?: number; timeoutMs?: number; keyId?: string; fetch?: typeof svc.fetch } = {}) {
  return RemotePolicySigner.fromConfig(
    { url: SIGNER_URL, apiKey: svc.apiKey, keyId: o.keyId ?? SIGNER_KEY_ID, timeoutMs: o.timeoutMs ?? 5_000, retries: o.retries ?? 2 },
    { network: NET, collectionAddress: h.signer.collectionAddress(), policy: h.settings.policy, fetch: o.fetch ?? svc.fetch, sleep: noSleep },
  );
}

function workerWith(h: Harness, signer: PolicySigner) {
  return new MintWorker({ orders: h.orders, store: h.store, content: h.content, reveals: h.reveals, chain: h.chain, parents: h.parents, signer, broadcasters: h.broadcasters, clock: h.clock });
}

const order = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

/** Independent check: input 0 of the broadcast reveal carries a valid BIP341 key-path signature by the collection key. */
function assertParentSignature(h: Harness, rawHex: string, commit: { script: Uint8Array; value: bigint }) {
  const tx = Transaction.fromRaw(hex.decode(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  const parentScript = hex.decode(h.collectionScriptHex);
  const digest = tx.preimageWitnessV1(0, [parentScript, commit.script], 0x00, [h.parentValue, commit.value]);
  const witness = tx.getInput(0).finalScriptWitness!;
  expect(witness).toHaveLength(1);
  expect(witness[0]!.length).toBe(64); // SIGHASH_DEFAULT: no hash-type byte
  expect(schnorr.verify(witness[0]!, digest, parentScript.slice(2))).toBe(true);
}

describe('RemotePolicySigner: mint -> @bsh/signer client -> platform signer service', () => {
  it('co-signs a real reveal end to end; the signer audits an allow by the mint key; the request is lean', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    const remote = remoteFor(h, svc);
    await remote.verify();
    const worker = workerWith(h, remote);
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await worker.tick();

    const o = await order(h, b.orderId);
    expect(o.status).toBe('revealed');
    expect(h.broadcasters.standard.sent).toHaveLength(1);
    assertParentSignature(h, h.broadcasters.standard.sent[0]!, {
      script: addressToScript(b.order.quote!.commitAddress!, NET),
      value: BigInt(b.order.quote!.commitValueSats),
    });
    expect(o.revealTxid).toBe(Transaction.fromRaw(hex.decode(h.broadcasters.standard.sent[0]!), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id);

    const records = svc.audit.list({});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'taproot-keypath', keyId: SIGNER_KEY_ID, principal: 'degent-mint', decision: 'allow' });
    // The 200 KB artwork never travels to the signer: only prevouts and outputs do.
    expect(svc.signCalls()).toHaveLength(1);
    expect(svc.signCalls()[0]!.bodyBytes).toBeLessThan(2_048);
    expect(b.bytes.length).toBeGreaterThan(100_000);
  });

  it('operator policy: SIGHASH_DEFAULT only, max input = PARENT_VALUE_SATS, max fee from the lane bands', () => {
    const svc = makeSignerService();
    expect(svc.cfg.allowedSighashTypes).toEqual([0x00]);
    expect(svc.cfg.maxInputSats).toBe(10_000n);
    expect(svc.cfg.maxFeeSats).toBe(508_725_000n);
    expect(maxFeeSatsFor()).toBe(508_725_000);
    expect(svc.cfg.outputAllowlist).toBeUndefined(); // output 1 pays each minter: an allowlist would refuse every reveal
    expect(svc.cfg.apiKeys[0]!.scopes).toEqual([`sign:${SIGNER_KEY_ID}`]);
  });

  it('a remote policy denial is a refusal: PolicyViolation, the order goes to self-rescue, nothing is broadcast', async () => {
    const h = makeHarness();
    // Policy mismatch between the mint and the signer: the signer caps the input below the parent value.
    const svc = makeSignerService({ overrides: { SIGNER_MAX_INPUT_SATS: '9999' } });
    const worker = workerWith(h, remoteFor(h, svc));
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    const rep = await worker.tick();
    const o = await order(h, b.orderId);
    expect(o.status).toBe('rescue_available');
    expect(o.timeline.at(-1)!.detail).toMatch(/refused by policy/);
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(svc.signCalls()).toHaveLength(1); // a decision is never retried
    expect(svc.audit.list({ decision: 'deny' })[0]!.reason).toMatch(/max-input-value/);
    expect(await h.parents.leasedBy()).toBeNull();
    expect(rep.errors).toEqual([]);
  });

  it('retries a 5xx (HSM hiccup -> key_provider_error) and signs on the next attempt', async () => {
    const h = makeHarness();
    const keys = new FlakyKeyProvider(new InMemoryKeyProvider([[SIGNER_KEY_ID, PARENT_KEY]]), 1);
    const svc = makeSignerService({ keys });
    const worker = workerWith(h, remoteFor(h, svc, { retries: 2 }));
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await worker.tick();
    expect((await order(h, b.orderId)).status).toBe('revealed');
    expect(keys.signAttempts).toBe(2);
    expect(svc.signCalls()).toHaveLength(2);
    expect(svc.audit.list({}).map((r) => r.decision).sort()).toEqual(['allow', 'error']);
  });

  it('retries ingress 503s up to SIGNER_RETRIES, then requeues the order (not rescue) and releases the parent', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    svc.setIntercept((c) => (c.url.endsWith('/v1/sign/taproot-keypath') ? new Response('upstream down', { status: 503 }) : null));
    const worker = workerWith(h, remoteFor(h, svc, { retries: 2 }));
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    const rep = await worker.tick();
    expect(svc.signCalls()).toHaveLength(3);
    const o = await order(h, b.orderId);
    expect(o.status).toBe('queued');
    expect(rep.errors.find((e) => e.step === 'dispatch')?.error).toMatch(/remote signer unavailable after 3 attempt/);
    expect(await h.parents.leasedBy()).toBeNull();
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    // The signer comes back: the next tick reveals.
    svc.setIntercept(null);
    await worker.tick();
    expect((await order(h, b.orderId)).status).toBe('revealed');
  });

  it('times out a hanging signer per attempt and gives up after the retry budget', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    let attempts = 0;
    const hanging: typeof svc.fetch = (url, init) => {
      if (!url.endsWith('/v1/sign/taproot-keypath')) return svc.fetch(url, init);
      attempts++;
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    };
    const remote = remoteFor(h, svc, { retries: 1, timeoutMs: 500, fetch: hanging });
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    const captured: PolicySignRequest[] = [];
    const worker = workerWith(h, {
      kind: 'remote',
      collectionAddress: () => remote.collectionAddress(),
      sign: (req) => (captured.push(req), remote.sign(req)),
    });
    const started = Date.now();
    const rep = await worker.tick();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(attempts).toBe(2);
    expect(rep.errors.find((e) => e.step === 'dispatch')?.error).toMatch(/network_error: .*timed out after 500 ms/);
    expect((await order(h, b.orderId)).status).toBe('queued');
    await expect(remote.sign(captured[0]!)).rejects.toBeInstanceOf(RemoteSignerFailure);
  });

  it('a local policy violation is refused before any network call', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    const remote = remoteFor(h, svc);
    // Capture a genuine request, then tamper with what the mint would ask for.
    const captured: PolicySignRequest[] = [];
    const worker = workerWith(h, { kind: 'remote', collectionAddress: () => remote.collectionAddress(), sign: async (req) => (captured.push(req), Promise.reject(new Error('captured'))) });
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await worker.tick();
    const req = captured[0]!;
    const before = svc.calls.length;
    for (const bad of [
      { ...req, context: { ...req.context, postage: req.context.postage + 1n } },
      { ...req, context: { ...req.context, quotedFeeRate: req.context.quotedFeeRate * 3 } },
      { ...req, context: { ...req.context, parentValue: req.context.parentValue + 1n } },
      { ...req, psbtBase64: 'not a psbt' },
    ]) {
      const err = await remote.sign(bad).catch((e) => e);
      expect(err).toBeInstanceOf(PolicyViolation);
    }
    expect(svc.calls.length).toBe(before);
    // The untampered request goes through.
    await expect(remote.sign(req)).resolves.toHaveProperty('psbtBase64');
    expect(svc.calls.length).toBe(before + 1);
  });

  it('configuration errors (bad API key, missing scope) are not retried and never become a refusal', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    const wrongKey = RemotePolicySigner.fromConfig(
      { url: SIGNER_URL, apiKey: 'bsh_test_' + '1'.repeat(44), keyId: SIGNER_KEY_ID, timeoutMs: 5_000, retries: 3 },
      { network: NET, collectionAddress: h.signer.collectionAddress(), fetch: svc.fetch, sleep: noSleep },
    );
    const captured: PolicySignRequest[] = [];
    const worker = workerWith(h, { kind: 'remote', collectionAddress: () => wrongKey.collectionAddress(), sign: (req) => (captured.push(req), wrongKey.sign(req)) });
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await worker.tick();
    expect(svc.signCalls()).toHaveLength(1);
    expect((await order(h, b.orderId)).status).toBe('queued');
    const err = await wrongKey.sign(captured[0]!).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteSignerFailure);
    expect(err).toMatchObject({ status: 401 });
  });

  it('verify(): the signer must run on our network and hold the COLLECTION_ADDRESS key', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    await expect(remoteFor(h, svc).verify()).resolves.toBeUndefined();
    await expect(remoteFor(h, makeSignerService({ network: 'signet' })).verify()).rejects.toThrow(/runs on signet, the mint on regtest/);
    const other = makeSignerService({ keys: new InMemoryKeyProvider([[SIGNER_KEY_ID, new Uint8Array(32).fill(9)]]) });
    await expect(remoteFor(h, other).verify()).rejects.toThrow(/not COLLECTION_ADDRESS/);
    await expect(remoteFor(h, svc, { keyId: 'nope' }).verify()).rejects.toThrow(/not readable/);
    expect(await remoteFor(h, svc).health()).toMatchObject({ ok: true });
    const down = RemotePolicySigner.fromConfig(
      { url: SIGNER_URL, apiKey: svc.apiKey, keyId: SIGNER_KEY_ID, timeoutMs: 5_000, retries: 0 },
      { network: NET, collectionAddress: h.signer.collectionAddress(), fetch: async () => Promise.reject(new Error('ECONNREFUSED')) },
    );
    expect(await down.health()).toMatchObject({ ok: false, detail: expect.stringMatching(/unreachable/) });
    await expect(down.verify()).rejects.toThrow(/unreachable/);
  });

  it('refuses an answer that does not verify for OUR transaction (signer returns a signature for something else)', async () => {
    const h = makeHarness();
    const svc = makeSignerService();
    const captured: PolicySignRequest[] = [];
    const remote = remoteFor(h, svc);
    const worker = workerWith(h, { kind: 'remote', collectionAddress: () => remote.collectionAddress(), sign: async (req) => (captured.push(req), Promise.reject(new Error('captured'))) });
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await worker.tick();
    const tampering: typeof svc.fetch = async (url, init) => {
      const res = await svc.fetch(url, init);
      if (!url.endsWith('/v1/sign/taproot-keypath')) return res;
      const body = (await res.json()) as { signature: string };
      body.signature = hex.encode(schnorr.sign(new Uint8Array(32).fill(1), PARENT_KEY));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const err = await remoteFor(h, svc, { fetch: tampering })
      .sign(captured[0]!)
      .catch((e) => e);
    expect(err).toBeInstanceOf(RemoteSignerFailure);
    expect(err.code).toBe('signature_invalid');
  });
});
