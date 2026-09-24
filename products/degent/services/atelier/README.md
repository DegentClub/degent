# @bsh/degent-atelier

**The Atelier** turns a short style brief ("DJ at a rooftop party", "pharaoh") into a Degent that passes the
collection's Minting Rules **by construction**, then gives the mint front end the exact bytes to inscribe.
It replaces the old "make it yourself in ChatGPT / Canva, download our sample, hope it passes" flow
(`degen-minter-3/components/AIInstructions.tsx`) and the standalone DALL-E frame combiner.

Contract: [`contracts/openapi/degent-atelier.yaml`](../../../../contracts/openapi/degent-atelier.yaml).
Consumer handoff: the bytes from `GET /v1/content/{sha256}` are PUT unchanged to the mint
(`PUT /v1/orders/{id}/content` in [`degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml)).

## The rules and who guarantees each

| Minting Rule (site spec) | How the Atelier guarantees it |
|---|---|
| Square JPEG, >= 200 KB | Compositor: cover-crop to a square, encode JPEG, size/quality search into the chosen tier's byte range |
| Pepe in a tuxedo with a **mandatory bow tie** | Prompt scaffold (fixed subject, tuxedo and bow tie, stated before the user's theme) + optional vision review |
| Framed, placard saying `DEGEN` / `DEGENT` / `REGEN` | Compositor draws the gold frame and the placard **itself** (vector assets, no fonts) |
| Tier by bytes: Standard 200,000-400,000 / Large 400,001-3,499,999 / Full Block 3,500,000-3,900,000 | Compositor byte-range search; the rules review re-checks the result |

### Why we draw the frame ourselves

Image models are bad at exact text and consistent ornament: the legacy flow produced "DEGNET" plaques, frames
that ate the character, and sizes all over the place. So the model is told to paint **no text, no frame and no
plaque**, and `src/assets/` renders them deterministically:

- `frame.ts` builds an SVG overlay (gold rail with bevel, weave, beads, corner rosettes, and a plate with
  screws), with every dimension proportional to the canvas, so 1024 px and 4096 px look the same.
- `glyphs.ts` draws the six letters the placard words need (D E G N R T) as stroked vector paths. Nothing
  depends on system fonts: librsvg's font fallback differs by host and would break byte-for-byte reproducibility.

The result is deterministic: the same source + tier + placard always gives the same bytes and the same SHA-256.

## Architecture

```
POST /v1/generate ─► AtelierService.createJob ─► quota + cost-cap check ─► reserve cost in ledger ─► queue
                                                                                                 │
worker tick() ◄──────────────────────────────────────────────────────────────────────────────────┘
   └► ImageProvider.generate(scaffolded prompt) ─► content store (source + 512px preview) ─► candidates
POST /v1/candidates/:id/finalize ─► compose(frame + placard + tier) ─► review ─► content store ─► sha256
GET  /v1/content/:sha256 ─► exact bytes (immutable) ─► browser PUTs them to the mint
POST /v1/upload ─► same compose (frame optional) + review
```

| Path | What |
|---|---|
| `src/prompt.ts` | Prompt scaffold, banned terms, injection and link guards |
| `src/compose.ts` | Compositor + byte-range search (sharp / libvips) |
| `src/assets/` | Frame + placard SVG, glyph paths |
| `src/review.ts`, `src/image-info.ts` | Rules review (magic bytes, header dims, square, bounds, size, tier); header sniffer |
| `src/providers/` | `ImageProvider` port; `OpenAiImageProvider`, `HttpImageProvider`, `FakeImageProvider` |
| `src/adapters/` | Content store (fs / memory), state store (sessions + cost ledger: node:sqlite / memory), Claude vision review |
| `src/application/atelier-service.ts` | Use cases, in-memory job queue, worker `tick()` |
| `src/app.ts` | Hono API on `@bsh/edge` (requestId, jsonErrors, securityHeaders, corsAllowlist, trustProxy, rateLimit, bodyLimit) |
| `src/config.ts`, `env.schema.json` | Env to typed config, fail-fast |

### Compositor search

1. Render the framed square at a canvas size from the ladder 512…4096 px (default start 1024).
2. Binary-search JPEG quality (5-100, 4:4:4, Huffman-optimised) for the **highest** quality that is still <= the tier max.
3. Too small even at q100: move up the ladder (probing 4096 first, then bisecting). Too big even at q5: move down.
4. If quality steps straddle the window (common near q100, where one step can exceed the 400 KB Full Block
   window), hold quality and bisect the **canvas edge** instead.
5. If the largest canvas at q100 is still under the minimum (flat, low-entropy art), blend in deterministic
   **canvas grain** (xorshift noise, overlay blend, amplitude 10 → 64) and retry. This adds bytes without
   changing the picture visibly at the low levels.
6. If nothing lands, the result is `range_unreachable` (HTTP 422), never non-compliant bytes.

Reachability from a clean 1024x1024 generated source (the fake provider's output, measured in tests):

| Tier | Typical result |
|---|---|
| Standard | 1024 px, q ~99, no grain |
| Large | 1024 px, q100 lands just over 400,001 B; larger canvases give headroom |
| Full Block | **not reachable without grain**: at 4096 px, q100 a clean source tops out around 2.2 MB, under the 3.5 MB minimum. With grain level 10 it lands at about 1792 px (~3.6 MB, ~7 s). Real provider art has more texture and needs less. |

A pure black image with `frame=false` cannot reach any tier (overlay grain cannot lighten black); the API
reports `range_unreachable`.

**Raster library: `sharp` 0.34 (libvips, prebuilt `@img/sharp-linux-x64`).** pnpm skips its install script,
but the prebuilt binary is resolved as an optional dependency, so no build step is needed. A pure-JS path
(`jpeg-js` + `pngjs`) was not needed. It would have been 10-50x slower at 4096 px, had no SVG
rasteriser (the frame would need a hand-written path filler), and its JPEG encoder has no Huffman
optimisation or 4:4:4 control, which makes the byte-range search coarser.

## Review

Same port shape as the mint's `ArtReview` (`name` + `review(input) -> { approved, reasons, checks }`), so
adapters move between services, but **re-implemented here**: components never import each other's internals.

- **Rules** (always on): magic bytes vs declared type, header-decoded dimensions, square, 256-4096 px, size in a tier,
  declared tier matches. It reads headers only (`src/image-info.ts`), independently of the decoder that produced the bytes.
- **Vision** (optional, `VISION_REVIEW_API_KEY`): Claude `claude-opus-5` with adaptive thinking, a structured
  JSON verdict and server-side refusal fallbacks (`fallbacks: "default"`), which is the same request shape as the mint's
  adapter. Unlike the mint (an approve-by-default safety gate), the Atelier's guidelines also check the design rules
  (Pepe, tuxedo, bow tie, portrait), because a generated candidate can simply be regenerated.
  It runs on raw candidates (`candidates[].review`) and, composed after the rules, on finalised and uploaded bytes.

## Provider setup

| Mode | Env | Notes |
|---|---|---|
| `fake` (default without a key) | none | Procedural Pepe-ish placeholder, deterministic per prompt/seed. `/v1/health` reports `provider.mode: "fake"`. |
| `openai` | `OPENAI_API_KEY` (+ `OPENAI_IMAGE_MODEL`, `OPENAI_FALLBACK_MODEL`, `OPENAI_IMAGE_QUALITY`) | `gpt-image-1` first; falls back to `dall-e-3` **only** when the model is unavailable to the key, never on content-policy or rate-limit errors. |
| `http` | `HTTP_PROVIDER_URL`, `HTTP_PROVIDER_STYLE` (`stability`/`replicate`/`generic`), `HTTP_PROVIDER_API_KEY`, `HTTP_PROVIDER_AUTH_HEADER`, `HTTP_PROVIDER_AUTH_SCHEME` | Body template per style; Replicate predictions are polled; image URLs are fetched only from the provider's host (the key is never sent elsewhere). |

Key hygiene: keys go only into the provider request header. Every provider failure becomes a `ProviderError`
with a fixed, user-safe `message` and a scrubbed `internal` string that is logged but never returned. Jobs that fail show
`{ code: "provider_unavailable" | "job_failed", message }` and nothing from upstream.

## Sessions, quotas and cost caps

- `POST /v1/sessions` issues an anonymous bearer token (`atl_…`, 256-bit). Only its SHA-256 is stored.
  Tokens expire after `SESSION_TTL_HOURS`, and at most `SESSIONS_PER_IP_PER_DAY` sessions can be created per IP.
- **Per-session daily quota** `SESSION_DAILY_IMAGES` (each variation counts, UTC day).
- **Global daily cost cap** `GLOBAL_DAILY_COST_CENTS`: every job **reserves** its estimated cost in the ledger
  before it is queued, so concurrent jobs cannot overshoot. Successful jobs settle at the actual image count;
  failed jobs settle at 0 and give their images back to the session's quota. Once the cap is reached, generation
  returns 503 `cost_cap_reached` and `/v1/health` is `degraded` until 00:00 UTC.
- Ledger table `ledger` (sqlite; in-memory in fake mode): `id, session_id, kind, images, cost_cents,
  status (reserved|settled|failed), provider, created_at, updated_at`.
- Rate limits: per client IP on everything (`RATE_LIMIT_PER_MINUTE`), and per session on generate, finalize and
  upload (`SESSION_RATE_LIMIT_PER_MINUTE`). Both are in-process token buckets from `@bsh/edge`.

## API summary

| Method | Path | Auth | Result |
|---|---|---|---|
| GET | `/v1/health` | - | status, provider mode, queue depth, spend vs cap |
| GET | `/v1/config` | - | tiers, placards, limits |
| POST | `/v1/sessions` | - | 201 `{ sessionId, token, expiresAt, quota }` |
| POST | `/v1/generate` | Bearer | 202 `{ jobId, status, statusUrl, quota }`; body `{ brief, palette?, mood?, placard, tier, variations<=4, seed? }` |
| GET | `/v1/jobs/{id}` | Bearer | status + `candidates[{ id, previewUrl, width, height, providerRef, review }]` |
| GET | `/v1/candidates/{id}/preview` | - (unguessable id) | 512 px JPEG preview, **not** the mint bytes |
| POST | `/v1/candidates/{id}/finalize` | Bearer | `{ contentSha256, contentLength, contentType, width, height, encoding, review, downloadUrl }` |
| POST | `/v1/upload` | Bearer | octet-stream (query `tier`, `placard`, `frame`) or multipart (`file`, …), <= 8 MiB |
| GET | `/v1/content/{sha256}` | - | exact bytes, `immutable`, `ETag: "<sha256>"` |

Errors: `{ "error": { "code", "message", "requestId", "details"? } }`. Validation failures list every problem in
`details.problems`.

## Run locally

```bash
pnpm --filter @bsh/degent-atelier dev      # fake mode, in-memory, http://127.0.0.1:8788
T=$(curl -s -XPOST localhost:8788/v1/sessions | jq -r .token)
J=$(curl -s -XPOST localhost:8788/v1/generate -H "authorization: Bearer $T" -H 'content-type: application/json' \
      -d '{"brief":"DJ at a rooftop party","placard":"DEGENT","tier":"standard","variations":2}' | jq -r .jobId)
curl -s localhost:8788/v1/jobs/$J -H "authorization: Bearer $T" | jq .
curl -s -XPOST localhost:8788/v1/candidates/<candidateId>/finalize -H "authorization: Bearer $T" \
     -H 'content-type: application/json' -d '{"tier":"standard","placard":"DEGENT"}' | jq .
curl -s localhost:8788/v1/content/<sha256> -o degent.jpg && sha256sum degent.jpg

pnpm --filter @bsh/degent-atelier test
pnpm --filter @bsh/degent-atelier typecheck
```

Operations: [RUNBOOK.md](./RUNBOOK.md).

## Known gaps

- Jobs, candidates and the queue are in-memory: a restart loses in-flight jobs. Their ledger reservations stay
  `reserved` and count against the day's cap until 00:00 UTC. Durable content and ledger survive restarts.
- Rate limiters and the job queue are per process: run one replica, or add a shared store (the `RateLimitStore` port) and a real queue.
- Candidate source bytes and previews are never garbage-collected from `CONTENT_DIR` (see RUNBOOK).
- Cost is an estimate from list prices, not the provider's invoice. Reconcile monthly.
