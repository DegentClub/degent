/**
 * Allow-list for the image proxy.
 *
 * DALL-E returns short-lived signed URLs on Azure blob storage, e.g.
 *   https://oaidalleapiprodscus.blob.core.windows.net/private/org-.../img-....png?st=...&se=...&sig=...
 * Newer OpenAI image endpoints serve from *.oaiusercontent.com and openai.com.
 * Nothing else is ever fetched server-side.
 */

export const ALLOWED_IMAGE_HOSTS: ReadonlyArray<string> = [
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidata.blob.core.windows.net',
  'openai.com',
]

/** Hosts where any subdomain is allowed. */
export const ALLOWED_IMAGE_HOST_SUFFIXES: ReadonlyArray<string> = [
  '.oaiusercontent.com',
  '.openai.com',
]

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB
export const PROXY_CACHE_SECONDS = 300 // 5 min: DALL-E URLs expire in about an hour

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

function ipv4Octets(host: string): number[] {
  return host.split('.').map((n) => parseInt(n, 10))
}

/**
 * True for loopback, link-local, private (RFC 1918), CGNAT, unspecified,
 * multicast, and IPv6 equivalents. Also true for bare "localhost".
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  if (isIPv4(host)) {
    const [a, b] = ipv4Octets(host)
    if (a === 0) return true // 0.0.0.0/8 unspecified
    if (a === 10) return true // 10/8
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
    if (a >= 224) return true // multicast + reserved
    return false
  }

  // IPv6 (URL.hostname keeps the brackets; stripped above)
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true // fe80::/10
    if (host.startsWith('fc') || host.startsWith('fd')) return true // fc00::/7 ULA
    if (host.startsWith('::ffff:')) return isPrivateAddress(host.slice('::ffff:'.length)) // v4-mapped
    return false
  }

  return false
}

export function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (ALLOWED_IMAGE_HOSTS.includes(host)) return true
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
}

/**
 * Validate a user-supplied URL before the server fetches it.
 * Order matters: parse -> scheme -> credentials -> IP literal / private -> allow-list.
 */
export function checkImageUrl(raw: string | null | undefined): UrlCheck {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'missing url' }
  if (raw.length > 4096) return { ok: false, reason: 'url too long' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid url' }
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'only https is allowed' }
  if (url.username || url.password) return { ok: false, reason: 'credentials in url are not allowed' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'non-standard port' }

  const host = url.hostname
  if (isIPv4(host) || host.includes(':')) return { ok: false, reason: 'ip literals are not allowed' }
  if (isPrivateAddress(host)) return { ok: false, reason: 'private address' }
  if (!isAllowedImageHost(host)) return { ok: false, reason: `host not allowed: ${host}` }

  return { ok: true, url }
}
