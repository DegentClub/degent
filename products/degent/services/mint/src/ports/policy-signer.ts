import type { PolicyContext } from '../domain/policy.js';

export interface PolicySignRequest {
  orderId: string;
  /** PSBT from @bsh/inscription.attachParent: input 0 (parent) unsigned, input 1 signed. */
  psbtBase64: string;
  /** Everything except the collection script, which the signer derives from its own key. */
  context: Omit<PolicyContext, 'collectionScript'>;
}

/** Result of a signer dependency check (`GET /v1/health` and startup preflight). */
export interface SignerHealth {
  ok: boolean;
  detail: string;
}

/**
 * Holds (or fronts) the collection parent key. Signs input 0 ONLY when the transaction satisfies
 * ADR-0002 §3 (see domain/policy.ts); otherwise throws PolicyViolation and logs.
 *
 * Adapters:
 *   - InMemoryPolicySigner (`SIGNER=memory`): raw key in process memory. Dev/test/regtest only; the
 *     service refuses to start on mainnet with it.
 *   - RemotePolicySigner (`SIGNER=remote`): the platform signer service (`@bsh/signer`, HSM port behind
 *     it) holds the key. The mint still evaluates `evaluateParentPolicy` BEFORE any network call; the
 *     remote signer then applies its own policy on top. The only signer mainnet accepts.
 */
export interface PolicySigner {
  readonly kind: 'memory' | 'remote';
  /** P2TR address of the parent key (where the parent must always return). */
  collectionAddress(): string;
  sign(req: PolicySignRequest): Promise<{ psbtBase64: string }>;
  /** Startup preflight: the signer is reachable, on our network, and holds the collection key. Throws otherwise. */
  verify?(): Promise<void>;
  /** Cheap dependency check for `GET /v1/health`. Absent = always ok (in-process signer). */
  health?(): Promise<SignerHealth>;
}
