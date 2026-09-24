# @bsh/degent-studio

The **Artist Studio** of degent.club. The Decentralized Gentlemen Club is a members' club, and the Club
is a place: membership is earned by making. An artist hangs a Degent by the house rules, any member can
mint it, and the house keeps the rules and the seal. The rules are code (`@bsh/degent-mint-sdk`,
`DEGENT_RULES`, `contracts/schemas/degent-rules.json`); the seal is the parent inscription co-signed by
the mint's policy signer (ADR-0002 §3). Nobody holds anyone else's keys or money.

This service is the studio's back office (design: [ADR-0007](../../../../docs/adr/0007-open-studio.md)):

- **Artist identity** by Sign-in-with-Bitcoin (`@bsh/identity`): the address that signs the challenge is
  the artist. Sessions are EdDSA JWTs (product `degent`, scope `artist`).
- **Payout address proven, not declared**: a segwit or taproot address plus a BIP-322 simple signature over
  `degent.club payout address <address> for <sessionSub>`. Legacy addresses are refused.
- **Artworks reviewed once, at submission**: rules on the real bytes, then the vision model against the
  Degent design rules. A skipped check never approves; the house resolves it.
- **Public gallery** (`featuredRank`, then featured, then newest) and immutable content bytes for approved pieces.
- **Royalty view**: mint records the mint service posts after each funding transaction, with totals.
- **Edition caps, curation, appeals, notifications** ([ADR-0012](../../../../docs/adr/0012-edition-caps-curation-appeals.md)):
  `maxEditions` per artwork, `featuredRank` for the front room, appeals of rejections to a human, and webhook /
  Telegram notifications to the artist through `@bsh/notify`.

Contracts: [`contracts/openapi/degent-studio.yaml`](../../../../contracts/openapi/degent-studio.yaml) (HTTP) and
[`contracts/asyncapi/degent-studio.yaml`](../../../../contracts/asyncapi/degent-studio.yaml) (`degent.artwork.{status}` events).

## Endpoints

| Method + path | Auth | What |
|---|---|---|
| `GET /v1/health`, `GET /v1/config` | none | Health; rules, formats, limits, SIWB / payout parameters |
| `POST /v1/auth/challenge` | none | SIWB message for `{ address, network }` (nonce bound to domain + address, single use) |
| `POST /v1/auth/verify` | none | `{ message, signature, address }` -> session JWT + artist profile (artist created on first sign-in) |
| `GET /v1/artists/me` | session | Private profile: display name, payout address, artwork counts |
| `PUT /v1/artists/me` | session | `displayName` (<= 40), `payout: { address, signature }` (BIP-322 proof), `notify: { webhookUrl?, telegramChatId?, rotateWebhookSecret? } \| null` |
| `GET /v1/artists/me/royalties` | session | Royalty records newest first + `totals` |
| `GET /v1/artists/{address}` | none | Public profile: display name, approved count, joinedAt |
| `POST /v1/artworks` | session | Declare `{ title <= 80, description? <= 500, contentType, contentLength, maxEditions? }` -> `submitted` + one-time `uploadToken` |
| `PUT /v1/artworks/{id}/content` | upload token | Exact bytes (octet-stream, <= 4 MiB); review runs here, once |
| `GET /v1/artworks` | optional | Gallery: `status` (default `approved`), `artist`, `available` (`true` hides sold-out), `page`, `pageSize` |
| `GET /v1/artworks/{id}` | optional | Public once approved; owner / API key see every status |
| `GET /v1/artworks/{id}/content` | none | Approved bytes only; `ETag: "<sha256>"`, `public, max-age=31536000, immutable`, 304 on `If-None-Match` |
| `DELETE /v1/artworks/{id}` | session | Artist delists (`approved -> delisted`) |
| `PUT /v1/artworks/{id}/editions` | session | Artist sets `{ maxEditions }` (1-10000 or null; never below `mintedEditions`) |
| `POST /v1/artworks/{id}/appeal` | session | Artist appeals a rejection `{ message <= 1000 }` -> `reviewing` + `needsHuman` (1 open, 3 max) |
| `POST /v1/artworks/{id}/review` | API key `studio:review` | House verdict `{ decision: approve\|reject, reasons? }` |
| `POST /v1/artworks/{id}/feature` | API key `studio:review` | `{ featured, rank? }` on approved artworks (gallery curation; rank 1-1000, lower first) |
| `GET /v1/appeals` | API key `studio:review` | The appeal queue: `status` (`open` default, `granted`, `denied`), oldest first |
| `POST /v1/internal/royalties` | API key `studio:internal` | The mint service records a royalty payment (idempotent on `orderId`; optional `edition`); counts one minted edition |

Errors are the `@bsh/edge` shape `{ error: { code, message, requestId, details? } }`; the code list is
`ErrorCode` in the contract. Mutating requests are rate limited per client IP; JSON bodies are capped at
16 KiB; browser origins are an exact allowlist (default deny).

## The rules and who checks each

`GET /v1/config` returns the same list (`DEGENT_RULES`, version `1.0.0`):

| Rule | Text | Check |
|---|---|---|
| `format` | JPEG recommended (PNG, WebP, AVIF, GIF accepted), 200 KB - 3.9 MB; the size picks the tier | automated (`validateContentMeta`, `formatAdvice`) |
| `square` | Width equals height, 256-4096 px a side | automated (`readImageInfo` + `requireSquare`) |
| `design` | Pepe character wearing a tuxedo with a mandatory bowtie | vision model or house reviewer |
| `framing` | Framed, with a placard reading DEGEN, DEGENT or REGEN | vision model or house reviewer |
| `quantity` | Mint as many as you want - no per-wallet cap | automated (there is no cap to enforce) |

Plus the moderation rules the mint applies (no sexual content, gore, hate symbols, personal data, scams,
blank images), in the vision guidelines (`src/domain/guidelines.ts`).

## Review pipeline (runs once, at `PUT /content`)

```
bytes -> sha256 -> content store (content-addressed)
      -> RulesArtReview   magic bytes, dimensions readable, type, size tier, width, height, square
      -> vision reviewer  ClaudeVisionReview (claude-opus-5, structured verdict) with DEGENT_GUIDELINES
                          or HumanGateReview when no VISION_REVIEW_API_KEY is set
      -> CompositeArtReview verdict:
           approved            -> submitted -> reviewing -> approved
           rejected            -> submitted -> reviewing -> rejected      (reasons kept on the artwork)
           needsHuman          -> submitted -> reviewing (needsHuman: true), waits for the house
           reviewer threw      -> 503 review_unavailable, artwork stays submitted, artist retries
```

**What needs a human** (`needsHuman: true`, listed with `GET /v1/artworks?status=reviewing` + a review key):

- no vision reviewer configured (`visionReview: none` in `/v1/config`);
- the bytes are AVIF (the model cannot take it);
- the image is larger than 3.7 MB and no pure-JS downscaler is wired (`jpeg-js` is not in the workspace
  lockfile, so none is; oversized images are never auto-approved).

A skipped check never approves. The house resolves with `POST /v1/artworks/{id}/review`, which can also take
down an approved piece (`approved -> rejected`) or reinstate a rejected one.

Transitions (`src/domain/artwork.ts`): `submitted -> reviewing -> approved | rejected`; `approved -> delisted`
(artist) or `rejected` (house); `rejected -> approved` (house) or `reviewing` (artist's appeal); `delisted` is
terminal. Every transition is persisted with a timestamp and emitted as `degent.artwork.<status>`
(`eventId = <artworkId>:<timeline index>`).

## Editions, curation and appeals (ADR-0012)

- **Edition caps.** `maxEditions` (1-10000, null = open edition) is set at declaration or later with
  `PUT /v1/artworks/{id}/editions`. Before the first mint anything goes; afterwards the cap can be raised, opened
  or lowered, never below `mintedEditions`. `mintedEditions` counts the royalty records the mint posted (replays
  do not count); `soldOut` = cap reached. The mint refuses new quotes for a sold-out artwork (409
  `artwork_not_mintable`, `details.soldOut`) and enforces the cap inside its edition reservation, counting its own
  live quotes, so two concurrent orders for the last edition get one quote and one 409. A quote issued before the
  cap was lowered still mints and is recorded.
- **Curation.** `featuredRank` (1-1000, lower first) on featured artworks; the gallery is rank ascending with
  unranked last, then featured, then newest.
- **Appeals.** A `rejected` artwork (automated rejection or house takedown) can be appealed by its artist:
  `rejected -> reviewing` with `needsHuman`, event detail `appeal`, one open appeal at a time and three per
  artwork. `POST /v1/artworks/{id}/review` resolves it (`granted` / `denied`); the house queue is
  `GET /v1/appeals`. Appeals appear on the artwork for the owner and API keys only.

## Artist notifications (ADR-0012)

Artists register targets with `PUT /v1/artists/me` `notify`: a webhook URL (validated by `@bsh/notify`'s
`validateWebhookTarget`: https, no credentials, no localhost / private literal IPs; regtest also allows http and
private hosts) and, when `TELEGRAM_BOT_TOKEN` is set, a Telegram chat id. The first webhook (or
`rotateWebhookSecret: true`) returns the artist's signing secret ONCE as `notifyWebhookSecret`.

| When | `kind` | Text |
|---|---|---|
| automated or house approval | `artwork.approved` | Your Degent '<title>' was approved and hangs in the gallery. |
| automated or house rejection | `artwork.rejected` | Your Degent '<title>' was rejected: <reasons>. |
| waiting for a human (skipped check, appeal) | `artwork.needs_human` | Your Degent '<title>' is waiting for a house reviewer. |
| new royalty record | `royalty.recorded` | Your Degent '<title>' was minted, edition #n, <sats> sats paid in <txid>:<vout> |

Webhooks receive the CloudEvents envelope (`type = degent.studio.notify.<sha256(address)[0..32]>.<kind>`,
`id` = `<artworkId>:<timeline index>` or `royalty:<orderId>`) signed with `Bsh-Signature` and an
`Idempotency-Key` (verify with `verifyWebhookSignature` from `@bsh/notify`); Telegram receives the text.
`BshArtistNotifier` (`src/adapters/bsh-artist-notifier.ts`) wires `@bsh/notify`'s `Notifier`, `WebhookChannel`
and `TelegramChannel` with in-memory subscription and delivery-log stores; the artist record is re-read before
every delivery, so nothing is lost across restarts except in-flight retries. Delivery runs after the request's
own work is persisted and never fails it.

## How the mint consumes artworks and posts royalties (next wave)

1. The mint front end lists `GET /v1/artworks` (approved, featured first) and lets a member pick a Degent.
2. It fetches `GET /v1/artworks/{id}/content` (immutable, ETag = sha256) and PUTs those exact bytes to the
   mint's `PUT /v1/orders/{id}/content`; the mint's own rules review re-checks them (ADR-0002 §5).
3. The funding PSBT the minter signs carries the royalty as **output [1]** (10% of the mint price, to the
   artist's proven `payoutAddress`) and the club fee as output [2] (ADR-0007 §5); the reveal is untouched.
4. When the mint sees the funding transaction, it calls `POST /v1/internal/royalties` with
   `{ orderId, artworkId, minterAddress?, royaltySats, fundingTxid, vout: 1, at, edition? }` (API key scope
   `studio:internal`; idempotent on `orderId`). The artist sees it at `GET /v1/artists/me/royalties`.
5. Inscription metadata attributes the artwork (artist address, artwork id, sha256).

## Architecture (ports and adapters)

| Path | What |
|---|---|
| `src/app.ts` | Hono API on `@bsh/edge` (requestId, jsonErrors, securityHeaders, corsAllowlist, trustProxy, rateLimit, bodyLimit, apiKeys) |
| `src/application/studio-service.ts` | Use cases: challenge / verify / sessions, profile + payout proof, artworks, house review, royalties |
| `src/domain/` | Artist, artwork (record, transition table, public view, appeals, edition cap), royalty, events, notifications, vision guidelines, errors |
| `src/ports/` | `ArtReview`, `ArtistStore`, `ArtworkStore`, `RoyaltyStore`, `ContentStore`, `EventBus`, `ArtistNotifier`, `Clock`, `NonceStore` (from `@bsh/identity`) |
| `src/adapters/bsh-artist-notifier.ts` | `ArtistNotifier` over `@bsh/notify` (signed webhooks, Telegram, retries, per-artist topics) |
| `src/adapters/memory-stores.ts`, `sqlite-store.ts` | In-memory stores; `node:sqlite` store (JSON row + version, optimistic writes) for artists, artworks, royalties, nonces |
| `src/adapters/content-stores.ts` | `FsContentStore` (`<dir>/<aa>/<sha256>`, temp + rename) and `MemoryContentStore` |
| `src/adapters/rules-art-review.ts` | `RulesArtReview`, `CompositeArtReview` (never approves on a skip), `HumanGateReview` |
| `src/adapters/claude-vision-review.ts` | Anthropic Messages API adapter (same model + request shape as the mint), optional `Downscaler` port |
| `src/adapters/system.ts`, `platform-event-bus.ts` | `MemoryEventBus`; `degent.artwork.{status}` topic + bridge onto `@bsh/events` |
| `src/config.ts`, `env.schema.json`, `src/wiring.ts`, `src/main.ts` | Env -> config (fail fast), composition root, entry point |

Tests (`test/`) run the whole service on the in-memory adapters with `@bsh/identity`'s own signing helpers
for SIWB and BIP-322, a fake vision reviewer, and ajv validation of every response against the OpenAPI and
every event against the AsyncAPI.

```bash
pnpm --filter @bsh/degent-studio dev        # regtest, in-memory, dev API keys printed once at start
pnpm --filter @bsh/degent-studio test
pnpm --filter @bsh/degent-studio typecheck
```
