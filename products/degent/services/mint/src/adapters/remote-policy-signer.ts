/**
 * PolicySigner backed by the platform signer service (`@bsh/signer`, contracts/openapi/signer.yaml in the
 * platform). The collection parent key lives behind the signer's `KeyProvider` port (env-fed software key
 * today, HSM tomorrow); this process never holds it. `SIGNER=remote` is the only signer mainnet accepts.
 *
 * Every co-signature goes through three independent gates:
 *
 *   1. LOCAL policy, before any network call: `evaluateParentPolicy` (ADR-0002 §3, exact shape) with the
 *      collection script derived from COLLECTION_ADDRESS. A violation throws `PolicyViolation` and nothing is
 *      sent (defence in depth: a compromised or misconfigured signer never even sees a bad request).
 *   2. REMOTE policy: the signer re-derives the input script from the key it holds, refuses script paths,
 *      computes the BIP341 sighash itself and applies its operator-configured policies (sighash types, max
 *      input value, max fee; RUNBOOK §7 lists the exact settings). A `403 policy_denied` is a decision: it is
 *      surfaced as `PolicyViolation`, exactly like a local refusal (the order goes to self-rescue).
 *   3. LOCAL verification of the answer: the returned signature must verify, under the collection output
 *      key, against the sighash WE compute for the transaction we will broadcast. Anything else is refused.
 *
 * What is sent: a LEAN copy of the PSBT (same version, locktime, inputs with their prevouts, outputs) without
 * input 1's leaf script and signature. BIP341 key-path sighashes commit to every prevout and output but to no
 * witness, so the digest (and the txid) are identical; the request stays a few hundred bytes instead of up to
 * 5 MB of base64 content (the signer's body limit is 256 KiB), and the artwork never reaches the signer.
 *
 * Retries: the platform client retries network failures only, because a 5xx "may already have produced an
 * audit record". For THIS request a retry is safe: signing input 0 of the same unsigned transaction again can
 * only yield another valid signature for the same txid (BIP340 aux randomness changes the wtxid, never what
 * is spent or paid). So the adapter owns the retry budget (client retries = 0): network errors, timeouts,
 * 429 and 5xx are retried with exponential backoff up to `retries` times, each producing its own audit record;
 * 4xx other than 429 are configuration or request errors and are never retried.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { base64 } from '@scure/base';
import { p2tr, Transaction } from '@scure/btc-signer';
import { addressToScript, networkParams, type Network } from '@bsh/inscription';
import { RemoteSignerClient, RemoteSignerError, type FetchLike } from '@bsh/signer';
import type { Logger } from '../application/logger.js';
import { silentLogger } from '../application/logger.js';
import { PolicyViolation } from '../domain/errors.js';
import { DEFAULT_POLICY, evaluateParentPolicy, type PolicyConfig } from '../domain/policy.js';
import type { PolicySigner, PolicySignRequest, SignerHealth } from '../ports/policy-signer.js';

/** The subset of `RemoteSignerClient` this adapter uses (tests may pass the real client over an in-process app). */
export type RemoteSignerApi = Pick<RemoteSignerClient, 'signTaprootKeyPath' | 'publicKey' | 'health'>;

/** The remote signer could not be used (unreachable, 5xx after retries, auth/config error, bad answer). NOT a policy decision. */
export class RemoteSignerFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | undefined,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'RemoteSignerFailure';
  }
}

export interface RemotePolicySignerOptions {
  client: RemoteSignerApi;
  /** Client for `health()`; defaults to `client`. A separate short-timeout client keeps /v1/health fast. */
  healthClient?: Pick<RemoteSignerClient, 'health'>;
  /** Signer key id holding the collection key (API key scope `sign:<keyId>`). */
  keyId: string;
  network: Network;
  /** COLLECTION_ADDRESS: the parent must always return here; `verify()` checks the signer's key matches. */
  collectionAddress: string;
  policy?: PolicyConfig;
  log?: Logger;
  /** Additional attempts after the first on network errors, timeouts, 429 and 5xx. Default 2. */
  retries?: number;
  /** Base backoff; doubles per attempt. Default 250 ms. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RemotePolicySignerConfig {
  url: string;
  apiKey: string;
  keyId: string;
  /** Per attempt. */
  timeoutMs: number;
  retries: number;
}

/** @bsh/signer network names equal the mint's. */
const SIGNER_NETWORK: Record<Network, string> = { mainnet: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' };

export class RemotePolicySigner implements PolicySigner {
  readonly kind = 'remote' as const;
  private readonly script: Uint8Array;
  private readonly outputKey: Uint8Array;
  private readonly policy: PolicyConfig;
  private readonly log: Logger;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private internalKey: Uint8Array | null = null;

  constructor(private readonly o: RemotePolicySignerOptions) {
    this.script = addressToScript(o.collectionAddress, o.network);
    if (this.script.length !== 34 || this.script[0] !== 0x51 || this.script[1] !== 0x20)
      throw new Error('COLLECTION_ADDRESS must be a taproot (P2TR) address');
    this.outputKey = this.script.slice(2);
    this.policy = o.policy ?? DEFAULT_POLICY;
    this.log = o.log ?? silentLogger;
    this.retries = o.retries ?? 2;
    this.retryDelayMs = o.retryDelayMs ?? 250;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Build from config: one client for signing (full timeout) and one for health (short timeout); both never retry themselves. */
  static fromConfig(
    cfg: RemotePolicySignerConfig,
    ctx: { network: Network; collectionAddress: string; policy?: PolicyConfig; log?: Logger; fetch?: FetchLike; sleep?: (ms: number) => Promise<void> },
  ): RemotePolicySigner {
    const base = { baseUrl: cfg.url, apiKey: cfg.apiKey, retries: 0, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) };
    return new RemotePolicySigner({
      client: new RemoteSignerClient({ ...base, timeoutMs: cfg.timeoutMs }),
      healthClient: new RemoteSignerClient({ ...base, timeoutMs: Math.min(cfg.timeoutMs, 2_000) }),
      keyId: cfg.keyId,
      network: ctx.network,
      collectionAddress: ctx.collectionAddress,
      retries: cfg.retries,
      ...(ctx.policy ? { policy: ctx.policy } : {}),
      ...(ctx.log ? { log: ctx.log } : {}),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
  }

  collectionAddress(): string {
    return this.o.collectionAddress;
  }

  /**
   * Startup preflight: the signer answers, runs on our network, and `keyId` is the collection key
   * (p2tr(xOnly) == COLLECTION_ADDRESS). Throws with an operator-readable message otherwise.
   */
  async verify(): Promise<void> {
    const h = await this.o.client.health().catch((e) => {
      throw new RemoteSignerFailure(`remote signer unreachable: ${errText(e)}`, 'network_error', undefined);
    });
    if (h.network !== SIGNER_NETWORK[this.o.network])
      throw new RemoteSignerFailure(`remote signer runs on ${h.network}, the mint on ${this.o.network}`, 'network_mismatch', undefined);
    const pk = await this.o.client.publicKey(this.o.keyId).catch((e) => {
      throw new RemoteSignerFailure(`remote signer key "${this.o.keyId}" is not readable: ${errText(e)}`, e instanceof RemoteSignerError ? e.code : 'network_error', e instanceof RemoteSignerError ? e.status : undefined);
    });
    const x = hex.decode(pk.xOnlyPublicKey);
    const address = p2tr(x, undefined, networkParams(this.o.network)).address;
    if (address !== this.o.collectionAddress)
      throw new RemoteSignerFailure(`remote signer key "${this.o.keyId}" controls ${address}, not COLLECTION_ADDRESS ${this.o.collectionAddress}`, 'key_mismatch', undefined);
    this.internalKey = x;
  }

  async health(): Promise<SignerHealth> {
    try {
      const h = await (this.o.healthClient ?? this.o.client).health();
      if (h.network !== SIGNER_NETWORK[this.o.network]) return { ok: false, detail: `remote signer runs on ${h.network}` };
      return { ok: true, detail: `remote signer ${h.status} (${h.network}, key ${this.o.keyId})` };
    } catch (e) {
      return { ok: false, detail: `remote signer unreachable: ${errText(e)}` };
    }
  }

  async sign(req: PolicySignRequest): Promise<{ psbtBase64: string }> {
    // Gate 1: our own policy, before anything leaves the process.
    const violations = evaluateParentPolicy(req.psbtBase64, { ...req.context, collectionScript: this.script }, this.policy);
    if (violations.length > 0) {
      this.log.warn('policy signer refused', { orderId: req.orderId, violations, signer: 'remote', stage: 'local' });
      throw new PolicyViolation(violations);
    }

    const full = Transaction.fromPSBT(base64.decode(req.psbtBase64), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const prevouts = [0, 1].map((i) => full.getInput(i).witnessUtxo!); // present: checked by evaluateParentPolicy
    const digest = full.preimageWitnessV1(0, prevouts.map((p) => p.script), 0x00, prevouts.map((p) => p.amount));

    // Gate 2: the remote signer's policy.
    const res = await this.callWithRetry(req.orderId, leanPsbt(full));

    // Gate 3: the answer must be a SIGHASH_DEFAULT signature over OUR digest by the collection output key.
    const sig = /^[0-9a-f]{128}$/.test(res.signature) ? hex.decode(res.signature) : null;
    if (res.sighashType !== 0x00 || res.digest !== hex.encode(digest) || !sig || !schnorr.verify(sig, digest, this.outputKey)) {
      this.log.error('remote signer returned a signature that does not verify for this reveal', { orderId: req.orderId, keyId: this.o.keyId, sighashType: res.sighashType });
      throw new RemoteSignerFailure('remote signer returned a signature that does not verify for this reveal', 'signature_invalid', undefined);
    }
    full.updateInput(0, { ...(this.internalKey ? { tapInternalKey: this.internalKey } : {}), tapKeySig: sig }, true);
    return { psbtBase64: base64.encode(full.toPSBT()) };
  }

  private async callWithRetry(orderId: string, psbtBase64: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.client.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: this.o.keyId, finalize: false });
      } catch (e) {
        if (!(e instanceof RemoteSignerError)) throw e;
        if (e.status === 403 && e.code === 'policy_denied') {
          this.log.error('policy signer refused', { orderId, signer: 'remote', stage: 'remote', reason: e.message, requestId: e.requestId });
          throw new PolicyViolation([`remote signer policy: ${e.message}`]);
        }
        const transient = e.code === 'network_error' || e.status === 429 || (e.status !== undefined && e.status >= 500);
        if (!transient) {
          this.log.error('remote signer rejected the request (configuration or request error; not retried)', { orderId, code: e.code, status: e.status, requestId: e.requestId });
          throw new RemoteSignerFailure(`remote signer: ${e.code}: ${e.message}`, e.code, e.status, e.requestId);
        }
        if (attempt >= this.retries) {
          this.log.error('remote signer unavailable; giving up for this tick', { orderId, code: e.code, status: e.status, attempts: attempt + 1, requestId: e.requestId });
          throw new RemoteSignerFailure(`remote signer unavailable after ${attempt + 1} attempt(s): ${e.code}: ${e.message}`, e.code, e.status, e.requestId);
        }
        this.log.warn('remote signer unavailable; retrying', { orderId, code: e.code, status: e.status, attempt: attempt + 1 });
        await this.sleep(this.retryDelayMs * 2 ** attempt);
      }
    }
  }
}

/** Same unsigned transaction and prevouts, without input 1's leaf script / signature (see the file comment). */
function leanPsbt(full: Transaction): string {
  const lean = new Transaction({ version: full.version, lockTime: full.lockTime, allowUnknownInputs: true, allowUnknownOutputs: true });
  for (let i = 0; i < full.inputsLength; i++) {
    const inp = full.getInput(i);
    lean.addInput({ txid: inp.txid!, index: inp.index!, witnessUtxo: inp.witnessUtxo!, ...(inp.sequence !== undefined ? { sequence: inp.sequence } : {}) });
  }
  for (let i = 0; i < full.outputsLength; i++) {
    const out = full.getOutput(i);
    lean.addOutput({ script: out.script!, amount: out.amount! });
  }
  return base64.encode(lean.toPSBT());
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
