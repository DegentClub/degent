import { timingSafeEqual } from 'node:crypto'

export const API_KEY_HEADER = 'x-atelier-key'
export const API_KEY_ENV = 'ATELIER_API_KEY'

export type AuthMode = 'api-key' | 'rate-limit'

/** Which protection applies to /api/generate-frame right now. */
export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  return env[API_KEY_ENV] && env[API_KEY_ENV]!.length > 0 ? 'api-key' : 'rate-limit'
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * True when the request carries the configured shared secret.
 * Always false when no key is configured — callers must fall back to
 * rate limiting in that case, never to "open".
 */
export function hasValidApiKey(headers: Headers, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env[API_KEY_ENV]
  if (!expected) return false
  const presented = headers.get(API_KEY_HEADER)
  if (!presented) return false
  return safeEqual(presented, expected)
}
