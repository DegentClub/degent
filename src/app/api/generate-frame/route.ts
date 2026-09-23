import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { authMode, hasValidApiKey, API_KEY_HEADER } from '@/lib/auth'
import { clientKeyFromHeaders, getGenerateRateLimiter, GENERATE_LIMIT } from '@/lib/rateLimiter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_DESCRIPTION_CHARS = 400

let client: OpenAI | null = null
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

/**
 * Generates a frame with DALL-E 3. Every call costs money, so the route is
 * protected in one of two explicit modes (see docs/SECURITY.md):
 *
 *   ATELIER_API_KEY set   -> the request must carry it in `x-atelier-key`
 *   ATELIER_API_KEY unset -> per-IP sliding window, 5 requests / 10 minutes
 */
export async function POST(request: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'server is not configured (OPENAI_API_KEY)' }, { status: 503 })
  }

  const mode = authMode()
  if (mode === 'api-key') {
    if (!hasValidApiKey(request.headers)) {
      return NextResponse.json(
        { error: `missing or invalid ${API_KEY_HEADER}` },
        { status: 401, headers: { 'WWW-Authenticate': API_KEY_HEADER } },
      )
    }
  } else {
    const key = clientKeyFromHeaders(request.headers)
    const verdict = getGenerateRateLimiter().hit(key)
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: `rate limit: ${GENERATE_LIMIT} frames per 10 minutes per address` },
        {
          status: 429,
          headers: {
            'Retry-After': String(verdict.retryAfterSeconds),
            'X-RateLimit-Limit': String(GENERATE_LIMIT),
            'X-RateLimit-Remaining': '0',
          },
        },
      )
    }
  }

  let description: unknown
  try {
    ;({ description } = await request.json())
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 })
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return NextResponse.json({ error: `description must be <= ${MAX_DESCRIPTION_CHARS} characters` }, { status: 400 })
  }

  // The centre is painted over by the user's image, so we do not ask for
  // transparency (DALL-E 3 cannot produce it and the request degrades the
  // border). We ask for a plain, dark centre the canvas will cover.
  const prompt = [
    `${description.trim()}.`,
    'A decorative square picture frame, seen straight on, filling the whole image edge to edge.',
    'Ornate border along all four sides with consistent width.',
    'The centre of the frame is a flat, solid, featureless dark panel — no picture, no text, no pattern inside the frame.',
    'Square 1:1 composition, sharp detail on the border.',
  ].join(' ')

  try {
    const response = await openai().images.generate({
      model: 'dall-e-3',
      prompt,
      size: '1024x1024',
      quality: 'standard',
      n: 1,
    })

    const image = response.data?.[0]
    if (!image?.url) {
      return NextResponse.json({ error: 'no image returned' }, { status: 502 })
    }

    return NextResponse.json({
      imageUrl: image.url,
      revisedPrompt: image.revised_prompt,
    })
  } catch (error) {
    console.error('generate-frame failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'frame generation failed' }, { status: 502 })
  }
}
