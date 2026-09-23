import type { PolicyContext } from '../domain/policy.js';

export interface PolicySignRequest {
  orderId: string;
  /** PSBT from @bsh/inscription.attachParent: input 0 (parent) unsigned, input 1 signed. */
  psbtBase64: string;
  /** Everything except the collection script, which the signer derives from its own key. */
  context: Omit<PolicyContext, 'collectionScript'>;
}

/**
 * Holds (or fronts) the collection parent key. Signs input 0 ONLY when the transaction satisfies
 * ADR-0002 §3 (see domain/policy.ts); otherwise throws PolicyViolation and logs.
 *
 * Adapters:
 *   - InMemoryPolicySigner: raw key in process memory. Dev/test/regtest only; the service refuses
 *     to start on mainnet with it.
 *   - KMS/HSM (TODO, see adapters/kms-policy-signer.ts): the key never leaves the HSM; the adapter
 *     computes the BIP341 key-path sighash for input 0 and asks the HSM for a Schnorr signature.
 */
export interface PolicySigner {
  readonly kind: 'memory' | 'kms';
  /** P2TR address of the parent key (where the parent must always return). */
  collectionAddress(): string;
  sign(req: PolicySignRequest): Promise<{ psbtBase64: string }>;
}
