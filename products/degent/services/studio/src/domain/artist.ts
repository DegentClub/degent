/** Artist aggregate: identity is the address that signed in (SIWB); the payout address is a separate, proven fact. */
import type { Network } from '@bsh/degent-mint-sdk';

export const DISPLAY_NAME_MAX_CHARS = 40;

export interface ArtistRecord {
  /** The signed-in address (session `sub`). Primary key together with the network. */
  address: string;
  network: Network;
  displayName: string | null;
  /** Segwit (P2WPKH) or taproot (P2TR) address proven by a BIP-322 simple signature. */
  payoutAddress: string | null;
  payoutVerifiedAt: string | null;
  joinedAt: string;
  updatedAt: string;
  version: number;
}

export interface ArtworkCounts {
  total: number;
  approved: number;
}

export interface Artist {
  address: string;
  network: Network;
  displayName: string | null;
  payoutAddress: string | null;
  payoutVerifiedAt: string | null;
  artworks: ArtworkCounts;
  joinedAt: string;
  updatedAt: string;
}

export interface PublicArtist {
  address: string;
  displayName: string | null;
  /** Approved artworks. */
  artworks: number;
  joinedAt: string;
}

export function toArtist(r: ArtistRecord, artworks: ArtworkCounts): Artist {
  return {
    address: r.address,
    network: r.network,
    displayName: r.displayName,
    payoutAddress: r.payoutAddress,
    payoutVerifiedAt: r.payoutVerifiedAt,
    artworks: { ...artworks },
    joinedAt: r.joinedAt,
    updatedAt: r.updatedAt,
  };
}

export function toPublicArtist(r: ArtistRecord, approved: number): PublicArtist {
  return { address: r.address, displayName: r.displayName, artworks: approved, joinedAt: r.joinedAt };
}

/** Kinds of address a royalty output may pay (segwit v0 keyhash or taproot). Legacy P2PKH / P2SH are refused. */
export const PAYOUT_ADDRESS_KINDS = ['p2wpkh', 'p2tr'] as const;

export const PAYOUT_MESSAGE_TEMPLATE = 'degent.club payout address <address> for <sessionSub>';

/** The exact text the payout address signs (BIP-322 simple) to prove the artist controls it. */
export function payoutMessage(payoutAddress: string, sessionSub: string): string {
  return PAYOUT_MESSAGE_TEMPLATE.replace('<address>', payoutAddress).replace('<sessionSub>', sessionSub);
}
