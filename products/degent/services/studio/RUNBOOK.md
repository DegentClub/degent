# degent-studio runbook

Service: `@bsh/degent-studio`. It holds no keys that move money: sessions are signed with an Ed25519 key that
only proves "this artist signed in here", payout addresses are proven by the artists' own wallets, and the
mint pays royalties directly from the minter's funding transaction (ADR-0007). Never edit rows by hand; if
an artwork must be moved, do it through the API with a review key, or through code with a test.

Useful reads (no token needed): `GET /v1/health`, `GET /v1/config`, `GET /v1/artworks`. With a
`studio:review` key: `GET /v1/artworks?status=reviewing` (the house queue), `?status=rejected`,
`GET /v1/appeals` (open appeals, oldest first).
Logs are JSON lines; unhandled errors log `unhandled error` with the `requestId` that the client saw.
Events: `degent.artwork.<status>` (contract `contracts/asyncapi/degent-studio.yaml`).

## 1. The review queue is growing (`needsHuman`)

`GET /v1/artworks?status=reviewing` with a review key. Each item's `review.automated.checks` says why the
automated review could not decide (`vision.guidelines` detail):

| Detail | Meaning | Action |
|---|---|---|
| `vision review not configured` | `VISION_REVIEW_API_KEY` is unset (`GET /v1/config` -> `visionReview: none`) | Expected in dev. In production set the key and redeploy; already-queued artworks still need a house verdict. |
| `... is not supported by the model` | AVIF submission | House verdict. |
| `... exceeds the model image limit` | > 3.7 MB image, no downscaler | House verdict. (A pure-JS downscaler can be wired in `src/wiring.ts` once `jpeg-js` is in the workspace lockfile.) |

Resolve with `POST /v1/artworks/{id}/review` `{ "decision": "approve" | "reject", "reasons": [...] }`.
Reasons are shown to the artist; name the rule ("rule 2: no bow tie").

## 2. Artists get 503 `review_unavailable` on upload

The vision API is down or timing out. Nothing is lost: the bytes are stored, the artwork stays `submitted`
and the artist retries the same `PUT` with the same upload token. If the outage is long, temporarily unset
`VISION_REVIEW_API_KEY` and redeploy: submissions then queue for the house instead of failing.

## 3. Taking down an artwork

`POST /v1/artworks/{id}/review` with `decision: reject` works on `approved` artworks too
(`approved -> rejected`); the content endpoint stops serving immediately (404) and the gallery drops it.
Reinstate with `decision: approve`. The bytes stay in the content store (content-addressed, other artworks
may share them); deleting blobs is a manual operation outside this service.

## 4. Session key rotation

1. Generate a new 32-byte Ed25519 secret; put it in the secret store as `SESSION_SIGNING_KEY` with a new
   `SESSION_KID`.
2. Move the OLD key's public key into `SESSION_PREVIOUS_KEYS=<old kid>:<public key hex>` so existing sessions
   keep verifying until they expire (`SESSION_TTL_SECONDS`, default 24 h).
3. Redeploy. After one TTL, drop the previous key.

Compromise: skip step 2 (all sessions are invalidated; artists sign in again, which costs them one wallet
signature). Nothing else is affected: sessions cannot spend anything.

## 5. API keys (house reviewers, the mint service)

Keys are `@bsh/edge` keys (`bsh_live_...` / `bsh_test_...`); the service stores only SHA-256 hashes in
`API_KEYS`. Mint one with `generateApiKey('live')` from `@bsh/edge`, hand the key to its owner once, add
`{ id, hash, scopes }` to `API_KEYS` and redeploy. Revoke by removing the record. Scopes: `studio:review`
(house reviewers, curation), `studio:internal` (the mint service: royalty records, reads any artwork).
Mainnet refuses `test` keys.

## 6. Royalty record disagreements

`POST /v1/internal/royalties` is idempotent on `orderId`; a replay with different facts is 409 with the
stored record in `details.existing`. The stored record is the truth of what the studio was told; the chain
(`fundingTxid:vout`) is the truth of what was paid. Reconcile from the chain, never by editing rows.

## 7. Backup and restore

`DATABASE_PATH` (sqlite, WAL) and `CONTENT_DIR` are the whole state. Back them up together; artworks reference
content by sha256, so a content blob missing at restore time makes its artwork's content endpoint 404 (the
artwork row still lists). SIWB nonces are in the same database and are harmless to lose (challenges just
have to be re-issued).

## 8. Appeals (ADR-0012)

`GET /v1/appeals` with a review key lists open appeals, oldest first; each names the artwork and carries the
artist's message. The artwork is `reviewing` with `needsHuman: true`, so it also shows in
`GET /v1/artworks?status=reviewing`. Resolve with `POST /v1/artworks/{id}/review`: `approve` grants the appeal,
`reject` denies it (give reasons naming the rule; the artist is notified with them). An artwork allows three
appeals in its lifetime; after that only a house reinstatement (`decision: approve` on the rejected artwork)
changes it. Appeal messages are the artist's words: never paste them into events, logs or tickets outside the
review tool.

## 9. Edition caps and sold-out artworks

`maxEditions`, `mintedEditions` and `soldOut` are on every artwork. `mintedEditions` counts royalty records; if it
looks wrong, compare `GET /v1/artists/me/royalties` (the artist's view) with the mint's orders for the artwork; the
chain (`fundingTxid:vout`) is the truth. `mintedEditions` above `maxEditions` is expected when the artist lowered the
cap while quotes were outstanding (those quotes still mint). A member who gets 409 `artwork_not_mintable`
(`details.soldOut`) from the mint while the studio still shows room is seeing live quotes held by other members;
they free up when those quotes expire (15 minutes).

## 10. Artist notifications failing

Notifications never fail a request; failures are logged as `artist notification delivery` (status `retrying` /
`failed`, channel, artist address; never the secret or the bot token) or `artist notification failed`. Webhooks
retry with backoff for about an hour (8 attempts); 4xx other than 408/425/429 are permanent (the artist's endpoint
refused). Telegram `403 bot was blocked by the user` is permanent: the artist must unblock the bot. Retries live in
process memory: a restart drops in-flight retries (the triggering transition or royalty is already persisted).
An artist who lost their webhook secret sends `PUT /v1/artists/me` `{ "notify": { "rotateWebhookSecret": true } }`.
Telegram is enabled by `TELEGRAM_BOT_TOKEN` (secret `services/degent-studio/telegram-bot-token`); rotating the bot
token is a redeploy, and chat ids stay valid for the same bot only.
