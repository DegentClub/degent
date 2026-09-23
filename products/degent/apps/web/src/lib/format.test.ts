import { describe, expect, it } from 'vitest';
import { formatBtc, formatCountdown, formatEta, formatFeeRate, formatSats, formatSize, groupDigits, ordinal, shortHash } from './format';

describe('format', () => {
  it('groups digits exactly, including bigint', () => {
    expect(groupDigits(1234567)).toBe('1,234,567');
    expect(groupDigits(12n)).toBe('12');
    expect(formatSats(2_000_000n)).toBe('2,000,000 sats');
  });
  it('renders BTC with 8 exact decimals', () => {
    expect(formatBtc(2_000_000)).toBe('0.02000000 BTC');
    expect(formatBtc(123_456_789n)).toBe('1.23456789 BTC');
    expect(formatBtc(1)).toBe('0.00000001 BTC');
  });
  it('sizes in SI units', () => {
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(312_456)).toBe('312.5 kB');
    expect(formatSize(3_900_000)).toBe('3.90 MB');
  });
  it('fee rates, countdowns, etas, ordinals, hashes', () => {
    expect(formatFeeRate(2)).toBe('2 sat/vB');
    expect(formatFeeRate(1.5)).toBe('1.5 sat/vB');
    expect(formatCountdown(299)).toBe('4:59');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(formatEta(30)).toBe('~30 min');
    expect(formatEta(130)).toBe('~2 h 10 min');
    expect(formatEta(null)).toBe('—');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(23)).toBe('23rd');
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaaaa');
  });
});
