/**
 * Site-wide links and copy captured from the live degent.club (products/degent/docs/site-spec.md).
 * Copy that was not captured is a visible `TODO(copy)` placeholder, never invented.
 */

export const SOCIAL = Object.freeze({
  x: 'https://x.com/degentclub',
  telegram: 'https://t.me/+cneroYQ-0VpmM2Ix',
  /** TODO(copy): the Instagram URL was not captured from the live site. */
  instagram: null as string | null,
});

/** "Buy" in the header: Magic Eden until first-party trading ships (site spec). */
export const MAGIC_EDEN_COLLECTION = 'https://magiceden.io/ordinals/marketplace/degentclub';

export function magicEdenItemUrl(inscriptionId: string): string {
  return `https://magiceden.io/ordinals/item-details/${inscriptionId}`;
}

export const TAGLINE = 'A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.';

export const COPY = Object.freeze({
  collectionHeroTitle: 'The Collection',
  collectionHeroSub: 'Together we’re minting bitcoin’s biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard on-chain.',
  cardBadge: 'ORDINAL COLLECTION',
  cardTitle: 'Decentralized Gentlemen Club',
  cardLine: 'The BIGGEST Ordinal collection on Bitcoin!',
  comicTitle: 'This is Gentlemen- The Comic',
  comicText: 'Learn the Degent Lore in this interactive comic book that is one of the biggest Bitcoin Ordinals in History.',
  minterTitle: 'Degen Minter',
  minterText: 'Create Bitcoin Ordinals Inscriptions.',
  rulesTitle: 'Minting Rules',
  rulesLede: 'The essential requirements for minting a Degent and joining the club.',
  didYouKnow: 'All approved Degents become part of the official Decentralized Gentlemen Club collection and are eligible for member-only benefits.',
  blogSub: 'Stories from the blockchain, insights from the community, and updates from the Decentralized Gentlemen Club.',
  newsletter: 'Stay updated with our latest news and drops.',
});
