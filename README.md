# Degent Atelier — frame & combine

The Decentralized Gentlemen Club's art tool. Generate a decorative frame with
DALL·E 3, set your portrait inside it, and export a 1024 × 1024 JPEG sized
for the chain: **200–400 KB, ready for the Degent mint**.

Next.js 14 (App Router), TypeScript, Tailwind, HTML5 canvas. Image
compositing happens in the browser; the server only talks to OpenAI.

## Quick start

```bash
npm install
cp .env.example .env        # add OPENAI_API_KEY (and optionally ATELIER_API_KEY)
npm run dev                 # http://localhost:3000
```

## How it works

1. **Frame** — describe a frame; `/api/generate-frame` asks DALL·E 3 for a
   square frame with a flat dark centre (DALL·E cannot produce transparency,
   so we do not ask for it). The returned signed URL is loaded through
   `/api/proxy-image` so the canvas is not tainted.
2. **Portrait** — drop an image. It never leaves the browser.
3. **Output** — the canvas draws the frame, then your portrait inside the
   border. Two sliders:
   - **Target file size** (200–400 KB): a binary search over JPEG quality
     (`findQualityForTargetSize`) lands within ~2% of the target using real
     `canvas.toBlob` byte counts.
   - **Frame border width** (5–25%): how much of the frame edge the
     portrait leaves visible.
4. **Download** — the result card shows exact bytes, an estimated
   inscription size in vbytes, and the fee at 1 sat/vB.

### Inscription estimate

Inscription content lives in the witness, so each content byte costs one
weight unit (¼ vB). The estimate is `ceil(bytes / 4) + 200 vB` of
commit/reveal overhead; fee = vbytes × fee rate. A 300 KB image is roughly
77,000 vB, i.e. ~77k sats at 1 sat/vB. Multiply by the live fee rate when you
mint.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | yes | DALL·E 3 access. Read at request time; the build does not need it. |
| `ATELIER_API_KEY` | no | Shared secret for `/api/generate-frame`. See below. |

## Protecting the generate endpoint

Every frame costs about $0.04. `/api/generate-frame` runs in exactly one of
two modes, chosen by whether `ATELIER_API_KEY` is set:

| `ATELIER_API_KEY` | Mode | Behaviour |
|-------------------|------|-----------|
| set | **api-key** | Requests must send the key in the `x-atelier-key` header. Wrong or missing key → `401`. No rate limit. |
| unset | **rate-limit** | Sliding window of **5 requests per 10 minutes per client IP** (first hop of `x-forwarded-for`, else `x-real-ip`). Over → `429` with `Retry-After`. |

The rate limiter is in-process memory; behind several instances it counts
per instance. For anything public-facing, set the key and put it behind
whatever front door you use. Full notes in [`docs/SECURITY.md`](docs/SECURITY.md).

The UI itself does not send the header — the api-key mode is for private
deployments where the operator adds it at the proxy or calls the API
directly:

```bash
curl -X POST https://atelier.example/api/generate-frame \
  -H 'content-type: application/json' \
  -H "x-atelier-key: $ATELIER_API_KEY" \
  -d '{"description":"gilded baroque frame, dark walnut"}'
```

## Image proxy

`/api/proxy-image?url=…` fetches only from the hosts DALL·E returns images on
(`oaidalleapiprodscus.blob.core.windows.net`, `oaidata.blob.core.windows.net`,
`*.oaiusercontent.com`, `openai.com` and subdomains), https only, no IP
literals, no private/loopback/link-local ranges, no redirects, 10 MB cap,
image content types only, cached for 5 minutes (the upstream URLs expire).
It does not send `Access-Control-Allow-Origin`; it is for same-origin use.

## Scripts

| Command | What |
|---------|------|
| `npm run dev` | dev server |
| `npm run build` / `npm start` | production |
| `npm test` | vitest: URL allow-list table, rate limiter, size-target search, inscription estimate |
| `npm run lint` | `next lint` |
| `npm run typecheck` | `tsc --noEmit` |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and build on every push.

## Design tokens

| Token | Value | Use |
|-------|-------|-----|
| `ink` | `#0f0f10` | page background |
| `ink-raised` | `#161618` | cards |
| `gold` | `#d4a843` | accent, primary actions, "in range" state |
| `btc` | `#f7931a` | **reserved** for BTC / cost figures (fee, DALL·E price) |
| display font | Playfair Display (`next/font`) | headings |
| body font | Inter (`next/font`) | everything else |

Tokens live in `tailwind.config.ts`; fonts are wired in `src/app/layout.tsx`.

## Project structure

```
src/
├── app/
│   ├── api/generate-frame/route.ts   # DALL·E call, auth / rate limit
│   ├── api/proxy-image/route.ts      # allow-listed same-origin image proxy
│   ├── layout.tsx                    # fonts + metadata
│   ├── page.tsx                      # the three-step flow
│   └── globals.css                   # tokens, range inputs, component classes
├── components/
│   ├── FrameGenerator.tsx
│   ├── ImageUploader.tsx
│   ├── OutputControls.tsx            # target size + border width sliders
│   └── FinalImageDisplay.tsx         # download, bytes, vbytes, fee
└── lib/
    ├── imageUtils.ts                 # compose, size search, inscription estimate
    ├── urlAllowlist.ts               # proxy URL policy
    ├── rateLimiter.ts                # sliding window
    └── auth.ts                       # x-atelier-key
test/                                 # vitest
docs/SECURITY.md
```

## License

MIT
