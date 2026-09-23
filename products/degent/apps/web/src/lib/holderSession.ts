/**
 * Holder sign-in for the review queue and the Telegram gate: connect a wallet, ask the mint for a
 * SIWB challenge, sign it with the wallet (BIP-322 simple), exchange it for a session token.
 * The token is a bearer credential: kept in memory only, never in URLs or localStorage.
 */
import type { AuthVerifyResponse } from '@bsh/degent-mint-sdk';
import type { Services, WalletId, WalletSession } from '../services/types';
import type { Network } from '@bsh/degent-mint-sdk';

export interface HolderSession {
  wallet: WalletSession;
  address: string;
  token: string;
  degents: number[];
  expiresAt: string;
}

export class NotAHolderError extends Error {
  constructor(readonly address: string) {
    super(`${address} holds no Degent. Only club members can enter here.`);
    this.name = 'NotAHolderError';
  }
}

/** Connect + SIWB. Throws NotAHolderError when the mint says the address holds no Degent. */
export async function signInAsHolder(services: Services, walletId: WalletId, network: Network): Promise<HolderSession> {
  const wallet = await services.wallets.connect(walletId, network);
  const address = wallet.ordinals.address;
  const challenge = await services.mintApi.authChallenge(address);
  const signature = await wallet.signMessage(challenge.message, address);
  let verified: AuthVerifyResponse;
  try {
    verified = await services.mintApi.authVerify(address, challenge.message, signature);
  } catch (e) {
    if (/not_a_holder/i.test(e instanceof Error ? e.message : String(e))) throw new NotAHolderError(address);
    throw e;
  }
  return { wallet, address, token: verified.token, degents: verified.degents, expiresAt: verified.expiresAt };
}
