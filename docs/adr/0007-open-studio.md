# ADR-0007: The Open Studio: artists sign in with Bitcoin, prove a payout address with BIP-322, hang rule-reviewed Degents that any member can mint with a royalty in the funding transaction

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-degent (product owner confirmed the Club vision and the Open Studio as the next milestone), platform (`@bsh/identity`, `@bsh/edge`, `@bsh/events` at pin 9298e7f)
- **Components:** `@bsh/degent-studio` (new), `@bsh/degent-mint-sdk`, `@bsh/degent-mint`, `@bsh/degent-web`, `@bsh/identity`, `@bsh/edge`, `@bsh/events`
- **Supersedes / Related:** builds on [ADR-0002](0002-degent-mint-architecture.md) (mint, policy signer, review before payment) and [ADR-0005](0005-strict-reveal-and-tiers.md) (0x81 reveals, user-held rescue key, tiers). Contracts: `contracts/openapi/degent-studio.yaml`, `contracts/asyncapi/degent-studio.yaml`, `contracts/schemas/degent-rules.json`.

## Context

The Decentralized Gentlemen Club is a **members' club, and the Club is a place**. Today the only way in is
to mint your own Degent: the mint (ADR-0002/0005) takes any rule-compliant image from anyone, with no human
in the loop. The published Minting Rules (site spec: square JPEG >= 200 KB; Pepe in a tuxedo with a
mandatory bowtie; framed with a placard reading DEGEN / DEGENT / REGEN; mint as many as you want) exist
only as prose on the site and as prompts in the Atelier; nothing in the repository holds them as data.

The product owner has confirmed the next milestone: **membership is earned by making.** An artist hangs a
Degent by the house rules, and any member can mint it. **The house keeps the rules and the seal:** the rules
are code, the seal is the parent inscription co-signed by the policy signer (ADR-0002 §3). Nobody holds
anyone else's keys or money.

That needs four things the mint does not have: an artist identity that is a wallet, not an account; a way
to pay artists that does not route money through us; a review that happens once per artwork instead of once
per mint order; and a public gallery. It also forces the rules into code so the studio, the mint and the
front end enforce and display the same list.

## Decision

### 1. Rules are code in the mint SDK

`@bsh/degent-mint-sdk` gains `DEGENT_RULES` (`format`, `square`, `design`, `framing`, `quantity`; each with
the published text and whether it is checked `automated`, by `vision`, or `both`), `DEGENT_RULES_VERSION`
(`1.0.0`), `recommendedContentType = 'image/jpeg'` with `formatAdvice()` (JPEG recommended; PNG, WebP, AVIF,
GIF accepted), and `validateContentMeta` gains a `square` check switched on by `CollectionConfig.requireSquare`
(`DEGENT_RULES_CONFIG`). The machine-readable twin is `contracts/schemas/degent-rules.json`; a test asserts
the two agree. The square check is opt-in so the mint's existing behaviour and contract are unchanged until
it adopts it.

### 2. Artist identity is Sign-in-with-Bitcoin

`@bsh/degent-studio` issues SIWB challenges (`@bsh/identity.issueChallenge`, nonce bound to the studio
domain and the address, single use, 5 minutes) and verifies them (`verifySignIn`: BIP-322 simple for
P2TR / P2WPKH, legacy signmessage for P2PKH / P2WPKH). The address that signed is the artist; the artist
record is created on first sign-in. Sessions are compact JWS (EdDSA) from a `SessionKeyRing` with product
and audience `degent` and scope `artist`; the signing key proves nothing but "signed in here" and can be
rotated without touching anything else.

### 3. The payout address is proven with BIP-322, and legacy addresses are refused

An artist's royalty destination is a separate fact from the sign-in address (artists sign in with a hot
wallet and get paid to a cold one). `PUT /v1/artists/me` accepts `payout: { address, signature }` where the
signature is a BIP-322 simple signature **by the payout address** over the fixed text
`degent.club payout address <address> for <sessionSub>`. Binding the session subject into the message means a
proof made for one artist cannot be replayed by another. Only P2WPKH and P2TR addresses are accepted:
legacy P2PKH / P2SH cannot produce BIP-322 simple signatures here and would make the funding transaction
larger; they are refused with `payout_address_legacy`.

### 4. An artwork is reviewed once, at submission, and a skipped check never approves

`POST /v1/artworks` declares an artwork (title <= 80, description <= 500, type, length; no per-artist cap)
and returns a one-time upload token. `PUT /v1/artworks/{id}/content` stores the exact bytes content-addressed
by sha256 and runs the review **once**: `RulesArtReview` on the real bytes (magic bytes, header dimensions,
bounds, square, size tier), then the vision reviewer (`ClaudeVisionReview`: the mint's model and request
shape with Degent-specific guidelines that must be positively satisfied, plus the mint's moderation list).
Outcomes: `approved`; `rejected` with reasons; or `reviewing` with `needsHuman: true` when a check was
skipped (no vision key, AVIF, image over the model's 3.7 MB limit with no pure-JS downscaler available).
The house (API key scope `studio:review`) resolves with `POST /v1/artworks/{id}/review`, may take down an
approved piece or reinstate a rejected one, and curates the gallery with `POST /v1/artworks/{id}/feature`.
The artist can delist (`approved -> delisted`). Every transition is persisted and emitted as
`degent.artwork.{status}`.

The mint keeps its own review before payment (ADR-0002 §5): it re-checks the same bytes cheaply; the vision
verdict is the studio's job.

### 5. Royalty = 10% of the mint price, carried as output [1] of the minter's funding PSBT (never the reveal)

When a member mints a studio artwork, the browser builds the funding transaction with:

- output [0]: the commit output (reveal fee + postage, exactly as today);
- **output [1]: the artist royalty, 10% of the mint price, to the artist's proven `payoutAddress`;**
- output [2]: the club fee, to the service fee address;
- change.

The royalty is **not** in the reveal, for three reasons that all come from ADR-0005:

1. **The reveal's outputs are pinned by the user's 0x81 signature** to `[parent return, child]`. Adding an
   output would either break the signature or require widening the policy signer's exact-shape checks, which
   ADR-0002 §3 and the product rules forbid ("never widen its checks to make a test pass").
2. **The rescue path must stay whole.** ADR-0005 §2's self-rescue is `[commit] -> [child]` re-signed by the
   user with K_e; the commit value is `reveal fee + postage` and nothing else. A royalty inside the commit
   value would either be lost in a rescue (the rescue has no royalty output) or would have to be added to a
   transaction the user signs alone, without us. Keeping the royalty in the funding transaction means a
   rescue changes nothing for the artist: they were paid when the minter paid.
3. **It is settled before anything else happens.** The funding transaction is the one the minter signs with
   their own wallet and broadcasts themselves; the royalty confirms with the commit, in the same transaction,
   whoever reveals. The service never touches it, so the design stays non-custodial for artists as it is for
   minters.

The mint verifies output [1] against the artwork's `payoutAddress` when it sees the funding transaction, then
records it at `POST /v1/internal/royalties` (`studio:internal`, idempotent on `orderId`); artists see
records and totals at `GET /v1/artists/me/royalties`. The studio is a ledger of what it was told; the chain
is the truth.

### 6. Open editions by default, attribution in the inscription

A studio artwork can be minted any number of times unless the artist delists it (open edition). Each mint
is a new inscription of the same bytes under the collection parent; the inscription metadata carries the
attribution (artist address, artwork id, content sha256) so provenance is on chain, not only in our tables.
Limited editions are a follow-up (a counter the mint checks before quoting).

## Alternatives considered

- **Email / password accounts.** Rejected: the Club is a Bitcoin place; a wallet is the identity and the
  payout is provable by the same key material. `@bsh/identity` already exists for this.
- **Trust a declared payout address.** Rejected: a typo or a swapped address sends royalties into the void,
  and support could not tell. A BIP-322 proof costs the artist one signature.
- **Pay royalties from the service (accumulate, then pay out).** Rejected: custodial, and needs a hot wallet.
- **Royalty as a reveal output.** Rejected for the three reasons in §5.
- **Review every mint order instead of the artwork.** Rejected: every mint of the same bytes would pay for
  the same vision call and could get a different verdict; the gallery would have no stable "approved" state.
- **Auto-approve when the vision check is skipped (the mint's current behaviour).** Rejected for the studio:
  it is the collection's front door, and the design rules are exactly what the automated rules cannot see.

## Consequences

- New service `@bsh/degent-studio` (experimental) with its own sqlite database and content directory; new
  secrets `services/degent-studio/{session-signing-key,vision-review-api-key,api-keys}`.
- The mint SDK is additive: `requireSquare`, `square` check, `recommendedContentType`, `formatAdvice`,
  `DEGENT_RULES*`, plus `contracts/schemas/degent-rules.json`. The mint's contract is unchanged.
- The house needs a review workflow (a queue UI on `GET /v1/artworks?status=reviewing`) and review keys.
- Without a vision key, every rule-compliant submission waits for a human; operations must staff that or set
  the key.
- Content is served publicly and immutably once approved; taking down an artwork stops serving but does not
  delete blobs (they may be shared).

Follow-ups (next wave, not in this ADR's code):

1. Mint service: consume studio artworks (fetch bytes by artwork id, re-check, quote with a 10% royalty
   output [1] and club fee output [2] in the funding PSBT, verify them when the commit is seen, post the
   royalty record), and carry attribution in the inscription metadata.
2. Web app: `/studio` (sign in, profile, payout proof, submit, my artworks, royalties) and the gallery
   picker in `/mint`.
3. Mint: adopt `requireSquare` (DEGENT_RULES_CONFIG) in its own contract.
4. Limited editions; a pure-JS JPEG downscaler once `jpeg-js` is in the workspace; a RabbitMQ binding for
   `degent.artwork.*` via `@bsh/events`.
