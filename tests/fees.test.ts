import { describe, expect, it, vi } from 'vitest';
import {
  COMMIT_VBYTES,
  FALLBACK_PRESETS,
  FEE_MAX,
  FEE_MIN,
  POSTAGE_SATS,
  REVEAL_OVERHEAD_VBYTES,
  clampFeeRate,
  estimateFeeSats,
  estimateInscriptionVbytes,
  fetchBtcUsdPrice,
  fetchMempoolPresets,
  formatBtc,
  formatUsd,
  isFeeRateInRange,
} from '@/lib/fees';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('clampFeeRate', () => {
  it('clamps below the minimum and above the maximum', () => {
    expect(clampFeeRate(0)).toBe(FEE_MIN);
    expect(clampFeeRate(0.1)).toBe(FEE_MIN);
    expect(clampFeeRate(-5)).toBe(FEE_MIN);
    expect(clampFeeRate(10_000)).toBe(FEE_MAX);
  });

  it('keeps in-range values and rounds to two decimals', () => {
    expect(clampFeeRate(1)).toBe(1);
    expect(clampFeeRate(2.345)).toBe(2.35);
    expect(clampFeeRate(0.13)).toBe(0.13);
  });

  it('falls back to the minimum for NaN and infinity', () => {
    expect(clampFeeRate(Number.NaN)).toBe(FEE_MIN);
    expect(clampFeeRate(Number.POSITIVE_INFINITY)).toBe(FEE_MAX);
    expect(clampFeeRate(Number.NEGATIVE_INFINITY)).toBe(FEE_MIN);
  });

  it('isFeeRateInRange agrees with the bounds', () => {
    expect(isFeeRateInRange(FEE_MIN)).toBe(true);
    expect(isFeeRateInRange(FEE_MAX)).toBe(true);
    expect(isFeeRateInRange(FEE_MIN - 0.01)).toBe(false);
    expect(isFeeRateInRange(FEE_MAX + 1)).toBe(false);
    expect(isFeeRateInRange(Number.NaN)).toBe(false);
  });
});

describe('estimates', () => {
  it('discounts witness bytes by 4 and adds the overhead', () => {
    expect(estimateInscriptionVbytes(0)).toBe(REVEAL_OVERHEAD_VBYTES);
    expect(estimateInscriptionVbytes(400)).toBe(100 + REVEAL_OVERHEAD_VBYTES);
    expect(estimateInscriptionVbytes(401)).toBe(101 + REVEAL_OVERHEAD_VBYTES);
    expect(estimateInscriptionVbytes(-1)).toBe(REVEAL_OVERHEAD_VBYTES);
  });

  it('estimateFeeSats scales with fee rate and includes postage', () => {
    const bytes = 300 * 1024;
    const vb = estimateInscriptionVbytes(bytes) + COMMIT_VBYTES;
    expect(estimateFeeSats(bytes, 1)).toBe(Math.ceil(vb * 1) + POSTAGE_SATS);
    expect(estimateFeeSats(bytes, 10)).toBe(Math.ceil(vb * 10) + POSTAGE_SATS);
    // out-of-range rates are clamped, never rejected
    expect(estimateFeeSats(bytes, 0)).toBe(Math.ceil(vb * FEE_MIN) + POSTAGE_SATS);
  });

  it('formats BTC and USD', () => {
    expect(formatBtc(100_000_000)).toBe('1.0');
    expect(formatBtc(12_345)).toBe('0.00012345');
    expect(formatUsd(100_000_000, 65_000)).toBe('$65,000.00');
    expect(formatUsd(50_000_000, 65_000)).toBe('$32,500.00');
    expect(formatUsd(1_234, 65_000)).toBe('$0.80');
  });
});

describe('fetchMempoolPresets', () => {
  it('maps the mempool.space payload to economy/normal/fast', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ fastestFee: 20, halfHourFee: 12, hourFee: 8, economyFee: 3, minimumFee: 1 })
    );
    const presets = await fetchMempoolPresets(fetchImpl as unknown as typeof fetch);
    expect(presets).toEqual({ economy: 3, normal: 12, fast: 20, live: true });
    expect(fetchImpl).toHaveBeenCalledWith('https://mempool.space/api/v1/fees/recommended', expect.anything());
  });

  it('falls back on network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchMempoolPresets(fetchImpl as unknown as typeof fetch)).toEqual(FALLBACK_PRESETS);
  });

  it('falls back on HTTP errors and malformed bodies', async () => {
    expect(await fetchMempoolPresets((async () => jsonResponse({}, false, 503)) as unknown as typeof fetch)).toEqual(
      FALLBACK_PRESETS
    );
    expect(
      await fetchMempoolPresets((async () => jsonResponse({ fastestFee: 'high' })) as unknown as typeof fetch)
    ).toEqual(FALLBACK_PRESETS);
  });

  it('clamps absurd live values into the allowed range', async () => {
    const presets = await fetchMempoolPresets(
      (async () => jsonResponse({ fastestFee: 5000, halfHourFee: 0.01, economyFee: 1 })) as unknown as typeof fetch
    );
    expect(presets.fast).toBe(FEE_MAX);
    expect(presets.normal).toBe(FEE_MIN);
  });
});

describe('fetchBtcUsdPrice', () => {
  it('returns the USD price', async () => {
    expect(await fetchBtcUsdPrice((async () => jsonResponse({ USD: 65432, EUR: 60000 })) as unknown as typeof fetch)).toBe(
      65432
    );
  });

  it('returns null when unavailable', async () => {
    expect(await fetchBtcUsdPrice((async () => jsonResponse({}, false, 500)) as unknown as typeof fetch)).toBeNull();
    expect(
      await fetchBtcUsdPrice((async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch)
    ).toBeNull();
  });
});
