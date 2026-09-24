/**
 * The REAL platform signer service (`@bsh/signer` createSignerApp + Signer + policies built by the signer's
 * own config loader), run in-process with an in-memory key provider holding the collection key. The mint's
 * RemotePolicySigner talks to it through the real RemoteSignerClient; only `fetch` is swapped for
 * `app.request`, so auth, scopes, PSBT inspection, BIP341 sighash, policy and audit are all exercised.
 *
 * `operatorSignerEnv` is the exact signer configuration RUNBOOK section 7 tells the operator to set.
 */
import { generateApiKey } from '@bsh/edge';
import {
  InMemoryAuditLog,
  InMemoryKeyProvider,
  Signer,
  apiKeyStoreFrom,
  createSignerApp,
  loadConfig as loadSignerConfig,
  taprootPoliciesFrom,
  type FetchLike,
  type KeyProvider,
} from '@bsh/signer';
import { DEFAULT_POLICY } from '../../src/domain/policy.js';
import { PARENT_KEY } from './harness.js';

export const SIGNER_KEY_ID = 'degent-parent';
export const SIGNER_URL = 'http://signer.test';

/** SIGNER_MAX_FEE_SATS = max over lanes of ceil(maxWeight / 4) x maxFeeRate x (1 + feeRateTolerance) (RUNBOOK §7). */
export function maxFeeSatsFor(policy = DEFAULT_POLICY): number {
  return Math.max(
    ...(['standard', 'block'] as const).map((l) => Math.ceil((Math.ceil(policy.maxWeight[l] / 4) * policy.bands[l].maxFeeRate * (1 + policy.feeRateTolerance)))),
  );
}

export function operatorSignerEnv(o: { network?: string; parentValueSats?: number; apiKeyHash: string; overrides?: Record<string, string> }): Record<string, string> {
  return {
    SIGNER_NETWORK: o.network ?? 'regtest',
    SIGNER_KEY_PROVIDER: 'env',
    SIGNER_KEY_IDS: SIGNER_KEY_ID,
    SIGNER_ALLOWED_PURPOSES: '',
    SIGNER_ALLOWED_SIGHASH: '0x00',
    SIGNER_MAX_INPUT_SATS: String(o.parentValueSats ?? 10_000),
    SIGNER_MAX_FEE_SATS: String(maxFeeSatsFor()),
    SIGNER_API_KEY_ENV: 'test',
    SIGNER_API_KEYS_JSON: JSON.stringify([{ id: 'degent-mint', hash: o.apiKeyHash, env: 'test', scopes: [`sign:${SIGNER_KEY_ID}`] }]),
    ...o.overrides,
  };
}

export interface SignerCall {
  url: string;
  method: string;
  bodyBytes: number;
}

export function makeSignerService(o: { network?: string; overrides?: Record<string, string>; keys?: KeyProvider } = {}) {
  const mintKey = generateApiKey('test');
  const cfg = loadSignerConfig(operatorSignerEnv({ apiKeyHash: mintKey.hash, ...(o.network ? { network: o.network } : {}), ...(o.overrides ? { overrides: o.overrides } : {}) }));
  const audit = new InMemoryAuditLog();
  const keys = o.keys ?? new InMemoryKeyProvider([[SIGNER_KEY_ID, PARENT_KEY]]);
  const signer = new Signer({
    keys,
    audit,
    allowedPurposes: cfg.allowedPurposes,
    allowedSighashTypes: cfg.allowedSighashTypes,
    taprootPolicies: taprootPoliciesFrom(cfg),
    network: cfg.network,
  });
  const app = createSignerApp({ signer, keys: apiKeyStoreFrom(cfg.apiKeys), keyEnv: cfg.keyEnv, auditLog: audit, maxBodyBytes: cfg.maxBodyBytes });
  const calls: SignerCall[] = [];
  /** Hook to inject ingress failures (e.g. a 503 from the proxy) before the request reaches the signer. */
  let intercept: ((call: SignerCall) => Response | Promise<Response> | null) | null = null;
  const fetch: FetchLike = async (url, init) => {
    const call = { url, method: init.method ?? 'GET', bodyBytes: typeof init.body === 'string' ? init.body.length : 0 };
    calls.push(call);
    const injected = intercept ? await intercept(call) : null;
    if (injected) return injected;
    return app.request(url, init);
  };
  return {
    app,
    audit,
    cfg,
    apiKey: mintKey.key,
    calls,
    fetch,
    setIntercept(fn: typeof intercept) {
      intercept = fn;
    },
    signCalls: () => calls.filter((c) => c.url.endsWith('/v1/sign/taproot-keypath')),
  };
}

/** A key provider whose first `failures` signatures throw (HSM hiccup -> signer 500 key_provider_error). */
export class FlakyKeyProvider implements KeyProvider {
  signAttempts = 0;
  constructor(
    private readonly inner: KeyProvider,
    private failures: number,
  ) {}
  keyIds() {
    return this.inner.keyIds();
  }
  publicKey(keyId: string) {
    return this.inner.publicKey(keyId);
  }
  async sign(keyId: string, msg32: Uint8Array, opts?: Parameters<KeyProvider['sign']>[2]) {
    this.signAttempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('HSM session lost');
    }
    return this.inner.sign(keyId, msg32, opts);
  }
}
