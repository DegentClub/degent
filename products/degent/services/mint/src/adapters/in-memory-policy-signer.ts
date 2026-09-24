/**
 * Dev/test policy signer holding the collection key in process memory (`SIGNER=memory`).
 * NEVER used on mainnet: config.ts refuses to start with it there (mainnet needs `SIGNER=remote`).
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { p2tr } from '@scure/btc-signer';
import { networkParams, signParentInput, type Network } from '@bsh/inscription';
import { PolicyViolation } from '../domain/errors.js';
import { DEFAULT_POLICY, evaluateParentPolicy, type PolicyConfig } from '../domain/policy.js';
import type { PolicySigner, PolicySignRequest } from '../ports/policy-signer.js';

export interface PolicyLogger {
  warn(msg: string, fields: Record<string, unknown>): void;
}

export class InMemoryPolicySigner implements PolicySigner {
  readonly kind = 'memory' as const;
  private readonly key: Uint8Array;
  private readonly address: string;
  private readonly script: Uint8Array;

  constructor(
    key: Uint8Array,
    network: Network,
    private readonly policy: PolicyConfig = DEFAULT_POLICY,
    private readonly log: PolicyLogger = { warn: (m, f) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...f })) },
  ) {
    if (key.length !== 32) throw new Error('parent key must be 32 bytes');
    this.key = Uint8Array.from(key);
    const pay = p2tr(schnorr.getPublicKey(this.key), undefined, networkParams(network));
    this.address = pay.address!;
    this.script = pay.script;
  }

  static random(network: Network, policy?: PolicyConfig): InMemoryPolicySigner {
    return new InMemoryPolicySigner(schnorr.utils.randomSecretKey(), network, policy);
  }

  collectionAddress(): string {
    return this.address;
  }

  collectionScript(): Uint8Array {
    return Uint8Array.from(this.script);
  }

  async sign(req: PolicySignRequest): Promise<{ psbtBase64: string }> {
    const violations = evaluateParentPolicy(req.psbtBase64, { ...req.context, collectionScript: this.script }, this.policy);
    if (violations.length > 0) {
      this.log.warn('policy signer refused', { orderId: req.orderId, violations });
      throw new PolicyViolation(violations);
    }
    return signParentInput(req.psbtBase64, this.key);
  }
}
