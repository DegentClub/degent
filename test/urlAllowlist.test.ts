import { describe, it, expect } from 'vitest'
import { checkImageUrl, isPrivateAddress, isAllowedImageHost } from '@/lib/urlAllowlist'

const DALLE_URL =
  'https://oaidalleapiprodscus.blob.core.windows.net/private/org-abc/user-xyz/img-123.png?st=2024-01-01T00%3A00%3A00Z&se=2024-01-01T02%3A00%3A00Z&sp=r&sv=2021-08-06&sr=b&sig=abc%3D'

const TABLE: Array<[string, boolean, string]> = [
  // allowed
  [DALLE_URL, true, 'signed DALL-E blob url'],
  ['https://oaidata.blob.core.windows.net/x/y.png', true, 'oaidata blob'],
  ['https://files.oaiusercontent.com/file-abc/img.png', true, 'oaiusercontent subdomain'],
  ['https://a.b.oaiusercontent.com/img.png', true, 'nested oaiusercontent subdomain'],
  ['https://openai.com/img.png', true, 'openai.com apex'],
  ['https://cdn.openai.com/img.png', true, 'openai.com subdomain'],
  ['https://OPENAI.COM/img.png', true, 'host is case-insensitive'],

  // rejected: scheme
  ['http://oaidata.blob.core.windows.net/x.png', false, 'http'],
  ['ftp://oaidata.blob.core.windows.net/x.png', false, 'ftp'],
  ['file:///etc/passwd', false, 'file scheme'],
  ['data:image/png;base64,AAAA', false, 'data url'],
  ['javascript:alert(1)', false, 'javascript'],

  // rejected: private / loopback / link-local / metadata
  ['https://169.254.169.254/latest/meta-data/', false, 'AWS metadata'],
  ['https://10.0.0.1/x.png', false, '10.x'],
  ['https://10.255.255.255/x.png', false, '10.x upper'],
  ['https://172.16.0.1/x.png', false, '172.16/12'],
  ['https://172.31.255.254/x.png', false, '172.31'],
  ['https://192.168.1.1/x.png', false, '192.168'],
  ['https://127.0.0.1/x.png', false, 'loopback'],
  ['https://localhost/x.png', false, 'localhost'],
  ['https://localhost:8443/x.png', false, 'localhost with port'],
  ['https://[::1]/x.png', false, 'ipv6 loopback'],
  ['https://[fe80::1]/x.png', false, 'ipv6 link-local'],
  ['https://[fd00::1]/x.png', false, 'ipv6 ULA'],
  ['https://0.0.0.0/x.png', false, 'unspecified'],
  ['https://100.64.0.1/x.png', false, 'CGNAT'],

  // rejected: any IP literal, even public
  ['https://8.8.8.8/x.png', false, 'public ip literal'],
  ['https://[2606:4700::1111]/x.png', false, 'public ipv6 literal'],

  // rejected: hosts not on the list / lookalikes
  ['https://example.com/x.png', false, 'random host'],
  ['https://evil.com/oaidata.blob.core.windows.net/x.png', false, 'allowed host in path'],
  ['https://oaidata.blob.core.windows.net.evil.com/x.png', false, 'allowed host as prefix of attacker domain'],
  ['https://notopenai.com/x.png', false, 'suffix lookalike'],
  ['https://oaiusercontent.com/x.png', false, 'apex of wildcard-only host is not allowed'],
  ['https://openai.com.evil.com/x.png', false, 'openai.com subdomain of attacker'],
  ['https://user:pass@openai.com/x.png', false, 'credentials'],
  ['https://openai.com:8443/x.png', false, 'non-standard port'],
  ['https://oaidata.blob.core.windows.net@evil.com/x.png', false, 'userinfo confusion'],

  // rejected: garbage
  ['', false, 'empty'],
  ['not a url', false, 'not a url'],
  ['//openai.com/x.png', false, 'protocol-relative'],
]

describe('checkImageUrl', () => {
  it.each(TABLE)('%s -> %s (%s)', (url, allowed) => {
    expect(checkImageUrl(url).ok).toBe(allowed)
  })

  it('rejects null and undefined', () => {
    expect(checkImageUrl(null).ok).toBe(false)
    expect(checkImageUrl(undefined).ok).toBe(false)
  })

  it('rejects absurdly long urls', () => {
    expect(checkImageUrl(`https://openai.com/${'a'.repeat(5000)}`).ok).toBe(false)
  })

  it('returns the parsed URL on success', () => {
    const r = checkImageUrl(DALLE_URL)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.hostname).toBe('oaidalleapiprodscus.blob.core.windows.net')
  })

  it('gives a reason on failure', () => {
    const r = checkImageUrl('http://openai.com/x.png')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/https/)
  })
})

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['169.254.169.254', true],
    ['172.20.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.169.0.1', false],
    ['8.8.8.8', false],
    ['localhost', true],
    ['foo.localhost', true],
    ['printer.local', true],
    ['::1', true],
    ['[::1]', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1111', false],
    ['openai.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateAddress(host)).toBe(expected)
  })
})

describe('isAllowedImageHost', () => {
  it('matches exact hosts and wildcard suffixes only', () => {
    expect(isAllowedImageHost('openai.com')).toBe(true)
    expect(isAllowedImageHost('x.openai.com')).toBe(true)
    expect(isAllowedImageHost('x.oaiusercontent.com')).toBe(true)
    expect(isAllowedImageHost('oaiusercontent.com')).toBe(false)
    expect(isAllowedImageHost('xopenai.com')).toBe(false)
  })
})
