import { describe, it, expect, vi } from 'vitest'
import {
  findQualityForTargetSize,
  estimateInscription,
  innerRect,
  clampBorderPercent,
  canvasToBlob,
  INSCRIPTION_OVERHEAD_VBYTES,
} from '@/lib/imageUtils'

/** Fake encoder: size grows linearly with quality between `lo` and `hi` bytes. */
function linearEncoder(lo: number, hi: number) {
  const calls: number[] = []
  const encode = vi.fn(async (q: number) => {
    calls.push(q)
    return { size: Math.round(lo + (hi - lo) * q) }
  })
  return { encode, calls }
}

describe('findQualityForTargetSize', () => {
  it('lands within 2% of the target when it is reachable', async () => {
    const { encode } = linearEncoder(20 * 1024, 900 * 1024)
    const r = await findQualityForTargetSize(encode, 300 * 1024)
    expect(Math.abs(r.sizeBytes - 300 * 1024)).toBeLessThanOrEqual(300 * 1024 * 0.02)
    expect(r.inRange).toBe(true)
    expect(r.quality).toBeGreaterThan(0.3)
    expect(r.quality).toBeLessThan(0.98)
  })

  it('returns max quality when even that is under target', async () => {
    const { encode } = linearEncoder(10 * 1024, 150 * 1024)
    const r = await findQualityForTargetSize(encode, 300 * 1024)
    expect(r.quality).toBe(0.98)
    expect(r.inRange).toBe(false)
    expect(r.iterations).toBe(1)
  })

  it('returns min quality when even that is over target', async () => {
    const { encode } = linearEncoder(600 * 1024, 2000 * 1024)
    const r = await findQualityForTargetSize(encode, 300 * 1024)
    expect(r.quality).toBe(0.3)
    expect(r.inRange).toBe(false)
    expect(r.iterations).toBe(2)
  })

  it('respects maxIterations', async () => {
    const { encode } = linearEncoder(20 * 1024, 900 * 1024)
    const r = await findQualityForTargetSize(encode, 300 * 1024, { maxIterations: 4 })
    expect(encode).toHaveBeenCalledTimes(4)
    expect(r.iterations).toBe(4)
  })

  it('prefers an in-range result over a closer out-of-range one', async () => {
    // Step function: q < 0.5 -> 190 KB (closest to a 199 KB target but out of range),
    // q >= 0.5 -> 210 KB (in range).
    const encode = async (q: number) => ({ size: q < 0.5 ? 190 * 1024 : 210 * 1024 })
    const r = await findQualityForTargetSize(encode, 199 * 1024)
    expect(r.sizeBytes).toBe(210 * 1024)
    expect(r.inRange).toBe(true)
  })

  it('works with a mocked canvas.toBlob', async () => {
    // Simulate an HTMLCanvasElement whose toBlob yields a Blob whose size tracks quality.
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void, _type: string, quality: number) => {
        const bytes = Math.round(50 * 1024 + 600 * 1024 * quality)
        cb(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
      },
    } as unknown as HTMLCanvasElement

    const r = await findQualityForTargetSize((q) => canvasToBlob(canvas, q), 250 * 1024)
    expect(r.value).toBeInstanceOf(Blob)
    expect(r.value.type).toBe('image/jpeg')
    expect(Math.abs(r.sizeBytes - 250 * 1024)).toBeLessThanOrEqual(250 * 1024 * 0.02)
  })

  it('rejects when toBlob yields null', async () => {
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(null),
    } as unknown as HTMLCanvasElement
    await expect(canvasToBlob(canvas, 0.9)).rejects.toThrow(/toBlob/)
  })

  it('honours custom byte bounds', async () => {
    const { encode } = linearEncoder(20 * 1024, 900 * 1024)
    const r = await findQualityForTargetSize(encode, 100 * 1024, {
      minBytes: 90 * 1024,
      maxBytes: 110 * 1024,
      minQuality: 0.01,
    })
    expect(r.inRange).toBe(true)
    expect(r.sizeBytes).toBeGreaterThanOrEqual(90 * 1024)
    expect(r.sizeBytes).toBeLessThanOrEqual(110 * 1024)
  })
})

describe('estimateInscription', () => {
  it('charges a quarter vbyte per content byte plus overhead', () => {
    const e = estimateInscription(300 * 1024, 1)
    expect(e.contentVBytes).toBe(76_800)
    expect(e.totalVBytes).toBe(76_800 + INSCRIPTION_OVERHEAD_VBYTES)
    expect(e.feeSats).toBe(e.totalVBytes)
  })

  it('scales with fee rate', () => {
    const one = estimateInscription(400_000, 1)
    const ten = estimateInscription(400_000, 10)
    expect(ten.feeSats).toBe(one.feeSats * 10)
  })

  it('rounds content vbytes up and clamps negatives', () => {
    expect(estimateInscription(1).contentVBytes).toBe(1)
    expect(estimateInscription(-50).contentBytes).toBe(0)
  })
})

describe('border geometry', () => {
  it('clamps the border to 5..25%', () => {
    expect(clampBorderPercent(1)).toBe(5)
    expect(clampBorderPercent(50)).toBe(25)
    expect(clampBorderPercent(12)).toBe(12)
    expect(clampBorderPercent(NaN)).toBe(15)
  })

  it('computes the inner rect symmetrically', () => {
    const r = innerRect(15, 1024)
    expect(r).toEqual({ x: 154, y: 154, width: 716, height: 716 })
    expect(r.x * 2 + r.width).toBe(1024)
    const thin = innerRect(5, 1024)
    expect(thin.width).toBeGreaterThan(r.width)
  })
})
