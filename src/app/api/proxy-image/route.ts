import { NextRequest, NextResponse } from 'next/server'
import { checkImageUrl, MAX_IMAGE_BYTES, PROXY_CACHE_SECONDS } from '@/lib/urlAllowlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FETCH_TIMEOUT_MS = 15_000
const ALLOWED_CONTENT_TYPES = /^image\/(png|jpeg|webp|gif)$/i

/**
 * Same-origin image proxy so the canvas can read DALL-E output without a
 * tainted-canvas error. Only allow-listed https hosts are fetched, redirects
 * are not followed, the body is capped at MAX_IMAGE_BYTES and the response is
 * cached briefly (the upstream URLs expire).
 */
export async function GET(request: NextRequest) {
  const check = checkImageUrl(request.nextUrl.searchParams.get('url'))
  if (!check.ok) {
    return NextResponse.json({ error: check.reason }, { status: 400 })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const upstream = await fetch(check.url, {
      redirect: 'manual', // never follow a redirect off the allow-list
      signal: controller.signal,
      headers: { accept: 'image/*' },
    })

    if (upstream.status >= 300 && upstream.status < 400) {
      return NextResponse.json({ error: 'upstream redirected; refusing to follow' }, { status: 502 })
    }
    if (!upstream.ok) {
      return NextResponse.json({ error: `upstream returned ${upstream.status}` }, { status: 502 })
    }

    const contentType = upstream.headers.get('content-type') ?? ''
    if (!ALLOWED_CONTENT_TYPES.test(contentType.split(';')[0].trim())) {
      return NextResponse.json({ error: 'upstream is not an image' }, { status: 502 })
    }

    const declared = Number(upstream.headers.get('content-length') ?? 0)
    if (declared > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 413 })
    }

    const body = await readCapped(upstream, MAX_IMAGE_BYTES)
    if (!body) {
      return NextResponse.json({ error: 'image too large' }, { status: 413 })
    }

    // Copy into a fresh ArrayBuffer so the body type is a plain ArrayBuffer.
    const payload = body.slice().buffer as ArrayBuffer

    return new NextResponse(payload, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': `private, max-age=${PROXY_CACHE_SECONDS}`,
        'X-Content-Type-Options': 'nosniff',
        // No Access-Control-Allow-Origin: same-origin use only.
      },
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return NextResponse.json(
      { error: aborted ? 'upstream timed out' : 'failed to fetch image' },
      { status: aborted ? 504 : 502 },
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Read the body but bail out (returning null) once it exceeds `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
