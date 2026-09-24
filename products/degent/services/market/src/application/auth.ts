/**
 * Ownership proof for listing create / cancel: a SIWB challenge (@bsh/identity) whose Request ID binds
 * the action, the inscription and (for `list`) the price, signed with BIP-322 simple. Verification is
 * the platform's `verifySignIn` (canonical message, domain, address, expiry, BIP-322 via
 * `verifyBip322Simple`'s verifier, single-use nonce consumed only after the signature verifies). This
 * file only binds the challenge to the marketplace action; there is no signature code here.
 */
import { issueChallenge, parseSiwbMessage, verifySignIn, type NonceStore } from '@bsh/identity';
import type { ChallengeAction, ChallengeResponse, Network } from '@bsh/degent-market-sdk';
import { DomainError } from '../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from './logger.js';

export interface ActionBinding {
  action: ChallengeAction;
  address: string;
  inscriptionId: string;
  priceSats?: number;
}

export function requestIdFor(b: ActionBinding): string {
  return b.action === 'list' ? `list:${b.inscriptionId}:${b.priceSats}` : `cancel:${b.inscriptionId}`;
}

export function statementFor(b: ActionBinding): string {
  return b.action === 'list'
    ? `List Degent ${b.inscriptionId} for ${b.priceSats} sats on the degent.club market.`
    : `Cancel the degent.club market listing of ${b.inscriptionId}.`;
}

export interface MarketAuthDeps {
  nonces: NonceStore;
  clock: Clock;
  network: Network;
  domain: string;
  uri: string | null;
  ttlSeconds: number;
  log: Logger;
}

export class MarketAuth {
  constructor(private readonly d: MarketAuthDeps) {}

  async challenge(b: ActionBinding): Promise<ChallengeResponse> {
    const ch = await issueChallenge(this.d.nonces, {
      domain: this.d.domain,
      ...(this.d.uri ? { uri: this.d.uri } : {}),
      address: b.address,
      network: this.d.network,
      ttlSeconds: this.d.ttlSeconds,
      statement: statementFor(b),
      requestId: requestIdFor(b),
      now: this.d.clock.now(),
    });
    return { message: ch.message, expiresAt: ch.fields.expirationTime };
  }

  /** Verify and consume. Throws 401 `auth_failed`; the reason is logged, not shown. */
  async verify(b: ActionBinding, proof: { message: string; signature: string }): Promise<void> {
    const fail = (why: string): never => {
      this.d.log.warn('market auth refused', { action: b.action, inscriptionId: b.inscriptionId, why });
      throw new DomainError('auth_failed', 401, `ownership proof refused: ${why}`);
    };
    let fields;
    try {
      fields = parseSiwbMessage(proof.message);
    } catch {
      return fail('malformed_message');
    }
    // Binding first, so a challenge for another action/price/inscription never burns its nonce.
    if (fields.requestId !== requestIdFor(b)) return fail('challenge_mismatch');
    const r = await verifySignIn(
      { message: proof.message, signature: proof.signature, address: b.address },
      { domain: this.d.domain, nonces: this.d.nonces, network: this.d.network, now: this.d.clock.now(), allowLegacy: false },
    );
    if (!r.ok) fail(r.error);
  }
}
