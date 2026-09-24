/** Ported from Degent-X-Bot test/bitcoin-address.test.js (table-driven). */
import { describe, expect, it } from 'vitest';
import { containsBitcoinAddress, findBitcoinAddresses } from '../src/content/bitcoin-address.js';

// Real-shaped sample addresses (well-known public examples / test vectors).
const CASES: Array<[string, boolean]> = [
  // bech32 P2WPKH
  ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', true],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', true],
  // bech32m P2TR
  ['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', true],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', true],
  // P2WSH
  ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', true],
  // uppercase bech32 is valid per BIP-173
  ['BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ', true],
  // P2SH
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', true],
  ['3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5', true],
  // P2PKH
  ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', true],
  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', true],
  // Embedded in sentences
  ['send it to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq, ser', true],
  ['(3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy)', true],
  ['addr:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2.', true],
  ['tip jar -> bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr!', true],

  // Negatives
  ['', false],
  ['gm gentlemen. the market awaits.', false],
  ['bc1', false],
  ['bc1 is the prefix for segwit', false],
  ['bc1q', false],
  ['bc1qshort', false], // too short
  ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdqbc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', false], // > 71 chars, glued
  ['bc1bio1', false], // b, i, o are outside the bech32 charset
  ['1.5 GB of blockspace and counting', false],
  ['178x', false],
  ['10,000 Degents', false],
  ['3 gentlemen walked into a bar', false],
  ['sat/vB era. 0.13 sat/vB, to be precise.', false],
  ['10000000000000000000000000000000', false], // 0 is not base58
  ['3OOOOOOOOOOOOOOOOOOOOOOOOOOOOO', false], // O is not base58
  ['1lllllllllllllllllllllllllllll', false], // l is not base58
  ['https://degent.club/mint/1234567890abcdef1234567890abcdef', false],
  ['abc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', false], // glued to letters on the left
  ['Degent #4,113 joined the Club. 372 KB, block 912,345.', false],
];

describe('containsBitcoinAddress', () => {
  it.each(CASES)('%j -> %s', (text, expected) => {
    expect(containsBitcoinAddress(text)).toBe(expected);
  });

  it('handles non-string input', () => {
    expect(containsBitcoinAddress(null)).toBe(false);
    expect(containsBitcoinAddress(undefined)).toBe(false);
    expect(containsBitcoinAddress(42)).toBe(false);
  });
});

describe('findBitcoinAddresses', () => {
  it('returns every address in the text', () => {
    const found = findBitcoinAddresses('pay bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq or 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
    expect(found).toEqual(['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy']);
  });

  it('returns an empty list when nothing matches, or for non-strings', () => {
    expect(findBitcoinAddresses('quietly bullish. loudly accumulating.')).toEqual([]);
    expect(findBitcoinAddresses(undefined)).toEqual([]);
  });
});
