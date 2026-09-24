# ADR-0012: Edition caps, curation and appeals: artists may cap editions (checked when the mint reserves one), the house ranks the gallery, a rejection can be appealed to a human, and artists are notified through @bsh/notify

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-degent (Open Studio plan Phase 5 item 4, roadmap p5.4), platform (`@bsh/notify` at pin 09bd9d7)
- **Components:** `@bsh/degent-studio`, `@bsh/degent-mint`, `@bsh/notify` (platform, consumed as is)
- **Supersedes / Related:** extends [ADR-0007](0007-open-studio.md) §4 (review, curation) and §6 (open editions;
  "limited editions are a follow-up"). The Open Studio plan (`docs/open-studio-plan.md` §3.4, §3.7, Phase 5)
  named this record ADR-0010; that number is the platform's mesh accountability layer, so this is ADR-0012.
  Contracts: `contracts/openapi/degent-studio.yaml` (additive), `contracts/openapi/degent-mint.yaml`
  (descriptions only).

## Context

ADR-0007 shipped open editions: an approved artwork can be minted any number of times. Artists asked for
limited editions, and the plan (§3.7) already fixed the behaviour: "artists may set `maxEditions`; when reached the
artwork is sold out and orders fail with `artwork_not_mintable`". Three facts shape how:

1. **Editions are reserved at quote time** (plan §3.4). The edition number is signed into the reveal's envelope
   before the minter pays, so the mint reserves it in its `EditionStore` for the quote's TTL (15 minutes) and turns
   the reservation into `Order.edition` at `paid`. The studio only hears about an edition after the funding
   transaction is seen (`POST /v1/internal/royalties`), minutes later.
2. **Quotes race.** Two members can ask for the last edition in the same second. A check against the studio's
   count alone would let both through; a check against the mint's own reservations outside the reservation's
   critical section would too.
3. **The chain is the truth.** Once a minter has paid for a quoted edition, the mint must reveal it (or the minter
   is stranded in rescue with a reveal signed for that number). A cap can only stop NEW quotes.

Separately, ADR-0007 gave the house a `featured` flag but no order among featured pieces, rejected artists had no
way to ask for a human look (the automated review and the house are final), and artists learned about verdicts
and royalties only by polling. The platform ships `@bsh/notify` (signed webhooks, Telegram, retries, idempotency
keys) for the last point.

## Decision

### 1. `maxEditions` on the artwork, owned by the artist

- `POST /v1/artworks` accepts `maxEditions` (integer 1..10000, or null / omitted = open edition).
  `PUT /v1/artworks/{id}/editions` `{ maxEditions }` changes it (owner session only; not on a `delisted` artwork).
- **Changing the cap.** Before the first mint any value is accepted. After it the cap may be **raised or opened**
  (null) and may be **lowered down to `mintedEditions`**, never below (409 `conflict`, `details.mintedEditions`).
  The cap is the artist's pacing tool, not an on-chain promise: the chain carries the edition number
  (attribution metadata), not the cap, and nothing on chain could enforce an immutable cap anyway. Collectors
  can see `maxEditions`, `mintedEditions` and `soldOut` on every artwork at any time.
- **Lowering does not cancel outstanding quotes.** A quote already issued keeps its reserved edition and, if
  paid, is minted and recorded; `mintedEditions` may then exceed a cap that was lowered after the quote. The
  studio accepts every royalty record (the chain is the truth) and reports `soldOut = mintedEditions >= maxEditions`.

### 2. The studio counts minted editions from royalty records

`mintedEditions` is the number of royalty records the studio holds for the artwork (one per paid order). It is
recomputed from the royalty store after each new record (never incremented, so a retry after a concurrent artwork
write converges) and not touched by replays. `POST /v1/internal/royalties` gains an optional `edition` (the number
the mint assigned); it is stored on the record, named in the artist's notification, and a replay that carries a
different edition than the stored one is 409 `conflict` (a replay without it is the same record).
Artwork responses gain `maxEditions`, `mintedEditions` and `soldOut`; `GET /v1/artworks?available=true` hides
sold-out pieces (`false` lists only them).

### 3. The mint enforces the cap inside the reservation

`StudioArtwork` gains `maxEditions?` / `mintedEditions?` (read from the studio's artwork response; an older studio
without them is an open edition). `POST /v1/orders` with `artworkId`:

1. refuses early with 409 `artwork_not_mintable` (`details.soldOut: true`) when the studio already counts
   `mintedEditions >= maxEditions`;
2. then reserves with `EditionStore.reserve(..., { maxEditions })`, which counts **consumed plus unexpired
   reservations** and throws `EditionsSoldOutError` when the count has reached the cap, **inside the same
   per-artwork critical section that picks the number**. That is the binding check: two concurrent quotes for the
   last edition get one number and one 409 (tested with 2 and with 8 concurrent orders).

`EditionStore.countActive(artworkId, now)` reports the same count. The order is now created under the id the
edition was reserved for (previously the reservation was released and re-taken under a second id, which left a
window in which a concurrent order could take the number).

### 4. Curation: `featuredRank`

`POST /v1/artworks/{id}/feature` accepts an optional `rank` (1..1000, lower first; needs `featured: true`; omitted
keeps the current rank, null clears it; unfeaturing clears it). The gallery order is **`featuredRank` ascending with
unranked last, then featured, then newest** (createdAt desc, id desc). Only a featured artwork's rank counts. The
SQLite store orders and filters on `json_extract` over the stored record, so databases written before this ADR
need no migration.

### 5. Appeals

- `POST /v1/artworks/{id}/appeal` `{ message }` (owner session; message 1..1000 characters) on a **`rejected`**
  artwork moves it `rejected -> reviewing` with `needsHuman: true` (a new edge in the transition table) and records
  the appeal on the artwork (`<artworkId>:appeal:<n>`, status `open`). The transition is emitted as
  `degent.artwork.reviewing` with detail `appeal`; the message never travels in events.
- **One open appeal at a time, at most 3 per artwork** over its lifetime (409 `conflict` with `details.appeals`
  and `details.max`); any other status is 409 `illegal_transition`. A house takedown (`approved -> rejected`) can
  be appealed like an automated rejection.
- The house resolves with the existing `POST /v1/artworks/{id}/review`: approve grants the appeal, reject denies it
  (the resolution carries the reasons, reviewer id and time). The queue is `GET /v1/appeals?status=open|granted|denied`
  (scope `studio:review`, oldest first).
- Appeals live on the artwork record so the transition and the appeal are one optimistic write; the SQLite store
  lists them with `json_each`. They are shown to the owner and API keys only, never in the public gallery.
- No new error codes: the studio's `ErrorCode` is a closed response enum, so appeals reuse `conflict`,
  `illegal_transition` and `validation_failed`.

### 6. Artist notifications through `@bsh/notify`

- `PUT /v1/artists/me` accepts `notify: { webhookUrl?, telegramChatId?, rotateWebhookSecret? } | null`. Webhook URLs
  are validated by `@bsh/notify`'s `validateWebhookTarget` (https, no embedded credentials, no localhost / private
  literal IPs; http and private hosts only on regtest). Telegram chat ids are accepted only when the studio has a
  bot (`TELEGRAM_BOT_TOKEN`, secret `services/degent-studio/telegram-bot-token`); `GET /v1/config` lists
  `notifyChannels`.
- **Per-artist webhook signing secret**, generated by the studio (`whsec_` + 256 bits) when a webhook is first set
  or on `rotateWebhookSecret`, **returned once** (`notifyWebhookSecret`), deleted with the webhook. Deliveries are
  CloudEvents envelopes signed `Bsh-Signature: t=..,v1=HMAC-SHA256(secret, "<t>.<raw body>")` with an
  `Idempotency-Key` (`webhooks.artistNotification` in the contract).
- The studio notifies when an artwork is **approved**, **rejected** (with the reasons) or **waits for a human**
  (including an appeal), and when a **royalty is recorded** ("Your Degent '<title>' was minted, edition #n, <sats>
  sats paid in <txid>:<vout>"). Submitted and delisted are not notified; a replayed royalty is not re-notified.
- **Routing.** `@bsh/notify` matches subscriptions by event type, so each artist has a private topic
  `degent.studio.notify.<first 32 hex of sha256(address)>.<kind>`. The artist record is the source of truth: the
  artist's subscriptions are re-synced from it right before each delivery, so the default in-memory subscription
  store and delivery log need nothing to survive a restart (a restart can only lose an in-flight retry).
- **A notification never fails the request that triggered it.** Delivery runs in the background after the
  transition or royalty record is persisted; errors are logged, retries and dead letters are the notifier's.

## Alternatives considered

- **Cap immutable after the first mint (or lower-only).** Stronger scarcity promise to early collectors. Not
  chosen: the cap is not on chain, so immutability would be a studio policy the chain cannot back, and artists asked
  to extend sell-out editions. Revisit if the cap is ever carried in the inscription metadata.
- **Check the cap against the studio's `mintedEditions` only.** Rejected: the studio learns about an edition only
  after payment, so every quote issued in the last 15 minutes would be invisible and concurrent quotes would
  overshoot.
- **A separate `countActive` then `reserve`.** Rejected: two awaits apart, two concurrent orders both see room.
  The count lives inside the reservation's critical section.
- **Refuse to consume a reservation above a lowered cap at `paid`.** Rejected: the reveal is already signed with
  that edition; refusing would strand a paying minter in rescue. Caps stop quotes, not payments.
- **A separate appeals table.** Rejected for now: embedding keeps the transition and the appeal in one optimistic
  write; the house queue is small. Revisit if appeals need their own lifecycle (comments, assignment).
- **Store webhook secrets in the platform secret store** (`@bsh/notify`'s recommendation). The studio has no write
  path to the secret store and each artist rotates their own; the secret sits on the artist row and is never
  returned after creation. It can only forge notifications to that artist, never move funds.
- **One Notifier subscription per artist created at registration.** Rejected: with in-memory stores the
  subscriptions would vanish on restart while the artist rows persist. Re-syncing at send time needs no migration
  and no startup scan.

## Consequences

- Studio contract: additive only (new optional fields, three paths, a `webhooks` entry); `oasdiff breaking` is clean.
  Mint contract: descriptions only (`artwork_not_mintable` now also means sold out, `details.soldOut`).
- The studio depends on `@bsh/notify` (component manifest updated; the catalog must be regenerated with
  `pnpm catalog`). New optional env `TELEGRAM_BOT_TOKEN`.
- The mint posts `edition` with each royalty record. A studio older than this ADR ignores the field (its royalty
  parser does not reject unknown keys) and a mint older than it reads no cap (open edition), so either service can
  deploy first; caps are only enforced once both run this ADR's code.
- Operations: the house has a second queue (`GET /v1/appeals`); the RUNBOOK covers appeals, caps and notification
  failures. Durable subscription/delivery-log stores remain Phase 5 item 3.
- Web app work (not in this ADR's code): cap field on submission, sold-out badge and `available=true` in the mint
  picker, appeal form, notification settings with the one-time secret.
