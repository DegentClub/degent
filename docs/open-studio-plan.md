# Degent Open Studio: engineering plan

Status: approved as the next product milestone (product owner, 2026-09-24). Board paper: "Degent Open Studio"
(agenda paper 01). Decision record: [ADR-0007](adr/0007-open-studio.md). Machine-readable status:
[`roadmap.json`](../roadmap.json) (validated by `pnpm roadmap:check`).

Degent Club is a members' club. The Club is a place; membership is earned by making (an artist hangs a Degent by
the house rules, any member can mint it); the house keeps the rules and the seal (the rules are code, the seal is
the parent inscription co-signed by the policy signer; nobody holds anyone else's keys or money).

This document is the plan an engineer or an agent works from. Each phase names the repository, the contract that
changes first (ADR-0004: contract, then code), the code paths, the tests that prove it and the exit criterion.
Where a decision is still open it is marked **DECISION** with the default we take if nobody objects.

## Vocabulary

- **Artist**: a wallet that signed in with Bitcoin and proved a payout address. No email, no KYC.
- **Artwork**: one reviewed, content-addressed image (sha256) with a title, an artist and a status.
- **Mint**: one order that inscribes an approved artwork as a child of the collection parent for a minter.
- **Mint price**: `commitValueSats + clubFeeSats` (network cost of the reveal plus the club's fee).
- **Artist royalty**: `floor(mintPriceSats × royaltyBps / 10_000)` with `royaltyBps = 1000`, paid as an output of
  the minter's funding transaction to the artist's proven payout address.
- **Club fee**: `floor(commitValueSats × clubFeeBps / 10_000)` per tier (default `clubFeeBps = 1000`), paid as an
  output of the funding transaction to `SERVICE_FEE_ADDRESS` (the existing service-fee mechanism).
- **Edition**: the n-th mint of an artwork (1-based, assigned when the order reaches `paid`).

## Phase 0: stabilise (done)

Shipped before this plan: strict 0x81 reveals and the user-held rescue key (ADR-0005), three tiers, the block-lane
weight budget, recovery bundle v2 and local rescue in the web app, CI on `claude/**` pushes, the CODEOWNERS org in
CI, a 120 s test budget for the large-reveal tests. Exit met: 170/170 mint-service tests, 107/107 web tests.

## Phase 1: Degent rules as code

Repository: `degent`. Package: `@bsh/degent-mint-sdk`, service `@bsh/degent-studio`, contract
`contracts/schemas/degent-rules.json`.

1. `validateContentMeta` gains the `square` check (width === height when dimensions are known).
2. `recommendedContentType = 'image/jpeg'`; PNG, WebP, AVIF and GIF stay accepted; the web app shows the advice.
3. The five published rules live as data in `degent-rules.ts` with `DEGENT_RULES_VERSION`, and the JSON Schema in
   `contracts/schemas/degent-rules.json` states the same constants; a test asserts they agree.
4. Vision review guidelines are Degent-specific: Pepe character, tuxedo, mandatory bowtie, framed, placard reading
   DEGEN, DEGENT or REGEN, plus the moderation rules. A skipped or failed vision check never approves: the artwork
   waits in `reviewing` with `needsHuman: true` for the house reviewer.
5. Rejections carry reasons in the artist's terms (the reviewer prompt asks for them; the API returns them).

Tests: SDK rule tests; a review corpus of compliant and non-compliant fixtures in the studio tests (fakes for the
vision port; the real adapter is exercised against recorded responses). Exit: zero false approvals on the fixture
corpus; every rejection has a reason.

## Phase 2: Artist Studio

Repository: `degent`. New service `products/degent/services/studio` (`@bsh/degent-studio`). Contracts:
`contracts/openapi/degent-studio.yaml`, `contracts/asyncapi/degent-studio.yaml`.

- **Identity**: `POST /v1/auth/challenge` and `POST /v1/auth/verify` (Sign in with Bitcoin via `@bsh/identity`,
  nonce store, session JWT with scope `artist`).
- **Profile and payout**: `GET|PUT /v1/artists/me`; the payout address is segwit or taproot on the configured
  network and proven by a BIP-322 simple signature over
  `degent.club payout address <address> for <sessionSub>`; `GET /v1/artists/{address}` is public.
- **Artworks**: `POST /v1/artworks`, `PUT /v1/artworks/{id}/content` (review runs once, here),
  `GET /v1/artworks/{id}`, `GET /v1/artworks?status=approved…` (gallery: featured first, then newest),
  `GET /v1/artworks/{id}/content` (approved only, immutable, ETag = sha256), `DELETE /v1/artworks/{id}` (delist),
  `POST /v1/artworks/{id}/review` and `/feature` (house reviewer, API key scope `studio:review`).
- **Royalties**: `GET /v1/artists/me/royalties`; `POST /v1/internal/royalties` (scope `studio:internal`, called by
  the mint service in Phase 3).
- **Events**: `degent.artwork.{submitted|reviewing|approved|rejected|delisted}`.
- **Stores**: memory and SQLite (JSON blob per row, optimistic version) for artists, artworks, royalties, nonces;
  content store content-addressed by sha256.

Exit: an artist can sign in with a wallet, upload, get a verdict with reasons, and see the piece listed; every
response validates against the contract.

## Phase 3: open mint with royalty

Repository: `degent` (mint service, mint SDK, web) and `scribbit` (platform ledger payees and the `psbt` payment
method, attribution metadata; consumed through a pin bump). Contract first in `contracts/openapi/degent-mint.yaml`
(all additions optional so the oasdiff gate passes).

### 3.1 Contract additions

- `CreateOrderRequest.artworkId?` (string). When present: `contentType`, `contentLength` and `contentSha256` are
  taken from the studio's artwork record; the content upload step is skipped; the order starts in `approved`
  (the artwork was reviewed at submission) after an internal transition `awaiting_content → reviewing → approved`
  recorded with `detail: "artwork <id> reviewed at submission"` so the shared status enum is unchanged.
- `Quote.clubFeeSats?`, `Quote.artistRoyaltySats?`, `Quote.artistAddress?`, `Quote.artworkId?`,
  `Quote.mintPriceSats?`; `totalSats` becomes `commitValue + clubFee + artistRoyalty` for artwork orders
  (documented; unchanged for non-artwork orders where both extras are zero).
- `Order.artworkId?`, `Order.artistAddress?`, `Order.artistRoyaltySats?`, `Order.clubFeeSats?`,
  `Order.edition?`, `Order.royaltyPaid?` (`{ txid, vout, sats }`).
- `ServiceConfig.royaltyBps?` (default 1000), `ServiceConfig.clubFeeBps?` per tier, `ServiceConfig.studioUrl?`.
- New error codes: `artwork_not_found`, `artwork_not_mintable` (not approved or delisted), `artist_payout_missing`.
- AsyncAPI: `OrderStatusEvent` gains optional `artworkId`, `artistAddress`; new channel
  `degent.mint.royalty.paid` `{ orderId, artworkId, artist, sats, txid, vout, at }`.
- Platform: `collection.minted` gains optional `artist`, `artworkId`, `edition`, `royalty { txid, vout, sats }`
  (minor bump of the platform topic, then pin bump).

### 3.2 Funding transaction layout (built in the browser, signed by the minter's wallet)

```
inputs : the minter's segwit/taproot payment UTXOs (legacy refused; the txid is known before signing)
[0]    : commit output, P2TR, value = quote.commitValueSats           (exists today)
[1]    : artist royalty, artist payout script, value = quote.artistRoyaltySats
[2]    : club fee, SERVICE_FEE_ADDRESS script, value = quote.clubFeeSats  (exists today as "service fee")
[3]    : change to the payment address when ≥ 546 sats                (exists today)
```

Rules: an output is omitted only when its value is 0; a royalty below the dust limit of the payout script type
(P2TR 330, P2WPKH 294) is raised to the dust limit and the quote says so; the web app refuses to proceed if the
wallet-altered transaction differs in txid, output scripts or values (extend the existing txid check).

### 3.3 Worker verification (mint service, `detectPayments`)

For an order with `artworkId`, after the commit output is seen: load the funding transaction's outputs, compare
**scripts** (never address strings) and sum the values paying the artist script and the club script; require
`artist ≥ artistRoyaltySats` and `club ≥ clubFeeSats`. Short payment → `rescue_available` with detail naming the
missing output; the parent is never co-signed. RBF-signalling unconfirmed funding transactions are treated as the
existing code treats them. On success record `royaltyPaid { txid, vout, sats }`, assign `edition` (next integer
per artwork, persisted atomically with the order transition), emit `degent.mint.royalty.paid`, and `POST` the
record to the studio's internal royalties endpoint (retry with backoff; idempotent on `orderId`).

### 3.4 Reveal and attribution

The reveal layout is unchanged (`[parent, commit] → [parent return, child]`, ADR-0005). The envelope carries
attribution in the metadata field (ord tag 5, CBOR): `{ artist, artwork, edition, studio: "degent.club" }`
encoded with `@bsh/inscription`'s `encodeAttribution` (pin bump). Because `edition` is assigned at `paid` and the
reveal is half-signed before payment, the browser signs the reveal with the **quoted** edition number (the
service reserves it at quote time with a TTL equal to the quote's; an expired reservation is released; a
reservation that is used becomes the edition). **DECISION**: reservation at quote time; default yes.

### 3.5 Ledger recording (platform `@bsh/ledger`, pin bump)

Each artwork order creates a ledger order (`product: degent`, `customerRef: <minter payment address>`) with line
items `network-cost` (no payee), `club-fee` (payee `club`), `artist-royalty` (payee `artist`, address and
scriptHex), a `psbt` payment intent whose expected outputs are derived from the payees, and, once the funding
transaction is verified, a payment evaluation from the observed outputs that yields `paid` and one payout record
per payee output. Receipts show payouts. The mint service is the ledger's client; the ledger never moves money.

### 3.6 Web

- Gallery entry to the mint flow: choose an artwork, then the existing connect → quote → pay → track steps.
- Quote and Pay screens show four lines: network cost, club fee, artist royalty, total (plus the funding fee the
  wallet shows). The artist's name and address are shown with the royalty line.
- `buildFundingPsbt` gains the royalty target; the post-sign check covers scripts and values.
- Track shows "artist paid" with the funding txid and output index once verified.
- Recovery bundle v2 stores `artworkId` and the reserved edition so a rescue reproduces the same envelope.

### 3.7 Edition semantics

Open editions by default (unbounded). **DECISION**: artists may set `maxEditions` on an artwork (Phase 5); when
reached the artwork is `sold_out` and orders fail with `artwork_not_mintable`. Nothing prevents the same bytes
being inscribed twice on Bitcoin; the edition number in the metadata and the studio's records are what make an
edition an edition.

### 3.8 Tests

Mint service: contract tests for every new field; worker tests for full payment, short royalty, short club fee,
wrong script, RBF-unconfirmed, edition assignment under concurrency (two orders of one artwork reach `paid`
together and get distinct editions); e2e from artwork order to `delivered` with the studio fake receiving the
royalty record; rescue after a simulated outage leaves `royaltyPaid` intact. Web: funding PSBT layout with the
royalty target, dust raise, post-sign mismatch refusal, quote lines. Exit: a signet mint pays the artist and the
club in one funding transaction, the reveal is co-signed, the ledger receipt matches the chain, and a rescue after
an outage still leaves the artist paid.

## Phase 4: provenance and certification (done)

block.space certify reads the attribution map from ord, signs it in the attestation, summarises artists, artworks
and editions, and serves `GET /v1/collections/{slug}/artists/{address}` (blockspace ADR-0008, 101 tests). Follow-up
when Phase 3 emits `collection.minted` with the royalty fields: extend the attestation with the funding txid and
output index.

## Phase 5: mainnet readiness

Repository: `degent`, `scribbit` (platform signer, events).

1. **Policy signer behind a remote signer.** The platform now ships `@bsh/signer` (policy-constrained remote
   signing service with an HSM port and audit log). Wire `SIGNER=remote` in the mint service through its client,
   keep `evaluateParentPolicy` in the mint service (the remote signer enforces its own policy on top), remove the
   mainnet refusal only for the remote signer. Rehearse failover on signet.
2. **Parent UTXO procedure.** Re-initialising the parent with a different value strands every awaiting 0x81
   reveal into rescue. Document the guarded procedure in the RUNBOOK (drain the queue, announce, re-lease, verify
   `PARENT_VALUE_SATS` unchanged) and alert on lease changes.
3. **Durable state.** SQLite stores everywhere by default in production configuration (orders, reveals, artworks,
   artists, nonces); `PlatformEventBusAdapter` wired to RabbitMQ through `connectAmqpBus` when `AMQP_URL` is set;
   notify subscriptions and delivery log persisted; artist notifications (email or Telegram) on `royalty.paid`.
4. **Edition caps and curation.** `maxEditions` on artworks; house curation (`featured`) drives the gallery front
   room; appeal workflow (artist requests a human review of a rejection).
5. **Security review** of the upload path (body limits, content sniffing, storage isolation), the royalty
   verification and the internal endpoints (API key scopes, replay).
6. **Game day** on signet: forced signer failover, bus outage, parent re-lease; no stranded orders, no unpaid
   artist.

Exit: the game day passes and the runbooks describe every recovery that was exercised.

## Phase 6: the world, and mainnet

1. **Site rebuild** per `products/degent/docs/site-spec.md`: collection, gallery, comic, mint process, blog, artist
   pages; counts from the block.space attestation; one app replacing WordPress, the mint subdomain and the
   marketplace.
2. **Agent surface**: the scribb.it MCP server gains gallery, quote and order tools over the ledger so an AI agent
   can mint a Degent on a person's behalf (mesh paper, Phase C).
3. **Mainnet launch** with a curated first wave of artists, then open submissions; weekly counts published from
   the certificate.

Exit: first mainnet Studio mint with an artist paid on chain.

## Decision records created by this plan

- ADR-0007 Open Studio (this milestone; `docs/adr/0007-open-studio.md`).
- ADR-0008 Attribution in certification (`DegentClub/blockspace`).
- ADR-0009 Ledger payees and the PSBT payment method (`DegentClub/scribbit`, with Phase 3's pin bump).
- ADR-0010 Edition reservations and caps (Phase 5, when `maxEditions` lands).

## Open decisions and their defaults

| Decision | Default | Who decides |
|---|---|---|
| Royalty base and top-up | 10% of mint price, on top of the minter's total | Board (paper 01, decision 2) |
| Club fee | 10% of network cost per tier | Board (decision 3) |
| Edition reservation at quote time | Yes | Engineering, in ADR-0010 |
| Artist eligibility | Any wallet with a proven payout address; no KYC | Board with counsel (decision 6) |
| Launch sequence | Signet at Phase 3 exit, mainnet at Phase 6 | Board (decision 7) |
