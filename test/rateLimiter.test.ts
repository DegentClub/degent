import { describe, it, expect } from 'vitest'
import { SlidingWindowRateLimiter, clientKeyFromHeaders } from '@/lib/rateLimiter'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit and then blocks', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: 600_000, now: c.now })

    for (let i = 0; i < 5; i++) {
      const r = rl.hit('1.2.3.4')
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(4 - i)
    }
    const blocked = rl.hit('1.2.3.4')
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfterSeconds).toBe(600)
  })

  it('slides: a slot frees when the oldest hit ages out', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000, now: c.now })

    rl.hit('k') // t=0
    c.advance(400)
    rl.hit('k') // t=400
    expect(rl.hit('k').allowed).toBe(false) // t=400, both inside window

    c.advance(601) // t=1001, first hit (t=0) has expired
    const r = rl.hit('k')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(0)

    expect(rl.hit('k').allowed).toBe(false) // t=400 and t=1001 both inside
    c.advance(400) // t=1401: hit at 400 expired
    expect(rl.hit('k').allowed).toBe(true)
  })

  it('reports retryAfter relative to the oldest hit', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 10_000, now: c.now })
    rl.hit('k')
    c.advance(2_500)
    const r = rl.hit('k')
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSeconds).toBe(8) // ceil(7500 / 1000)
    expect(r.resetAt).toBe(1_000_000 + 10_000)
  })

  it('isolates keys', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now })
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('b').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
    expect(rl.hit('b').allowed).toBe(false)
  })

  it('does not count blocked attempts against the window', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now })
    rl.hit('k')
    for (let i = 0; i < 10; i++) rl.hit('k') // hammering while blocked
    c.advance(1001)
    expect(rl.hit('k').allowed).toBe(true) // only the first hit was recorded
  })

  it('peek does not record', () => {
    const rl = new SlidingWindowRateLimiter({ limit: 3, windowMs: 1000 })
    expect(rl.peek('k')).toBe(0)
    rl.hit('k')
    expect(rl.peek('k')).toBe(1)
    expect(rl.peek('k')).toBe(1)
  })

  it('reset clears one key or all', () => {
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000 })
    rl.hit('a')
    rl.hit('b')
    rl.reset('a')
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('b').allowed).toBe(false)
    rl.reset()
    expect(rl.hit('b').allowed).toBe(true)
  })

  it('sweeps idle keys so memory does not grow forever', () => {
    const c = clock()
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 100, now: c.now })
    for (let i = 0; i < 600; i++) rl.hit(`ip-${i}`)
    c.advance(1000)
    for (let i = 0; i < 500; i++) rl.hit('live')
    expect(rl.size).toBeLessThan(600)
  })

  it('rejects nonsense options', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1 })).toThrow()
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow()
  })
})

describe('clientKeyFromHeaders', () => {
  it('uses the first x-forwarded-for hop', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })
    expect(clientKeyFromHeaders(h)).toBe('203.0.113.5')
  })

  it('falls back to x-real-ip, then unknown', () => {
    expect(clientKeyFromHeaders(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7')
    expect(clientKeyFromHeaders(new Headers())).toBe('unknown')
  })
})
