# ADR-0008: First-party marketplace settles with a padding-input PSBT layout; buys ship disabled

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** club owner, team-degent
- **Components:** `@bsh/degent-market` (new), `@bsh/degent-market-sdk` (new); consumes `@bsh/inscription`,
  `@bsh/identity` (platform) and `@bsh/degent-mint-sdk`
- **Supersedes / Related:** replaces the settlement engine of antron3000/Degent-Marketplace (legacy, branch
  `claude/magical-einstein-ugdy2r`); [ADR-0002](0002-degent-mint-architecture.md) (non-custodial rule),
  [ADR-0005](0005-sighash-all-anyonecanpay-reveals.md) (why the mint signs 0x81),
  [ADR-0007](0007-member-approval-and-register.md) (who is a Degent); `roadmap.yaml` p0.4, p3.1–p3.5, p3.11–p3.14;
  design detail in `products/degent/services/market/docs/SETTLEMENT.md`

## Context

The club's exchange lived in a separate Express app. An audit found its purchase transaction put the inscription at
input 0 and the seller's price at output 0; by ord's first-in-first-out rule the inscribed sat went to output 0, so
**the seller kept the Degent and the price**. The buyer's wallet did not warn because the engine had the buyer sign a
placeholder input with `ALL|ANYONECANPAY` and transplanted the signature; `tap_internal_key` carried the tweaked
key; the seller's signature was never verified. Buys were switched off (`BUYS_ENABLED=false`) and the engine was
rewritten (padding inputs, FIFO assertion, real verification, 69 tests), but:

1. it re-implemented the FIFO rule locally, while `@bsh/inscription` now ships the platform's
   `assignSats` / `inscriptionDestination` / `assertNoInscriptionBurn`, used by the mint and cross-checked against
   shared vectors (rule: one implementation of the maths);
2. it verified BIP-322 with `bip322-js` and its own challenge table, while `@bsh/identity` ships SIWB challenges,
   BIP-322 simple verification and single-use nonces (used by the mint's member approval);
3. "is this a Degent" was a bundled JSON that knows nothing about approved, parent-linked children (ADR-0007);
4. none of it had been exercised with a real wallet or chain (five wallet/chain items, SETTLEMENT.md §7).

## Decision

### 1. The marketplace is a product slice of this monorepo

`products/degent/services/market` (`@bsh/degent-market`, Hono, ports and adapters, like the mint) and
`products/degent/packages/market-sdk` (`@bsh/degent-market-sdk`: types, layout constants, price/royalty/fee maths,
typed client). Contracts first: `contracts/openapi/degent-market.yaml`, `contracts/asyncapi/degent-market.yaml`
(`degent.market.listing.{status}`, owned by this product). No mint service code is imported; shared vocabulary goes
through the mint SDK (types, `ApiError`, the Register client).

### 2. Padding-input layout, seller signs input 2 with SIGHASH_SINGLE|ANYONECANPAY

```
[pad, pad, INSCRIPTION (seller, 0x83), payment…] → [pad merge → buyer, postage → buyer, price → seller, royalty → treasury?, change → buyer?]
```

The seller signs once, offline, at index 2 (BIP341 commits to the input index), committing to their input and to
output #2 only; any buyer completes it. Two buyer padding inputs (600–1000 sats each) ahead of the inscription make
output #1, the buyer's postage, receive exactly the inscription UTXO's sats, so the inscription keeps its offset in
the buyer's output. 0x81 (the mint's choice, ADR-0005) is impossible here: the buyer's inputs, change and royalty
are unknown when the seller signs. Buyers sign the **real** transaction; the wallet's inscription warning is
expected and explained.

### 3. One implementation of the FIFO maths: `@bsh/inscription`

The service has no FIFO calculator. `src/domain/settlement/fifo.ts` asks `assertNoInscriptionBurn` where the
inscription lands and refuses unless it is output 1, at its original offset, paying the buyer's script exactly the
postage. It runs before any buy PSBT is returned and again on the exact raw bytes before broadcast. The padding
layout puts funding ahead of the inscription, so the platform's burn-proof invariant `checkInscriptionCoverage`
does not hold by construction; the explicit destination assertion replaces it. The legacy unsafe layout is kept as a
test fixture showing the seller receiving the inscription.

### 4. Identity and membership come from the platform and the Register

List and cancel require a SIWB challenge from `@bsh/identity` whose Request ID binds `list:<id>:<price>` or
`cancel:<id>`, signed with BIP-322 simple and verified by `verifySignIn` (single-use nonce, consumed only after the
signature verifies; memory or node:sqlite `NonceStore`). A listing is accepted only for a Degent: a roster (Gallery)
inscription or a parent-linked child, answered in production by the mint's public Register
(`GET /v1/register/verify/{id}` via `@bsh/degent-mint-sdk`), or by roster JSON + ord `/r/parents` behind the same
`CollectionMembership` port. Listing validity (outpoint unspent, inscription there, seller holds it) comes from
injectable chain and ord ports; the settlement watcher derives `sold` / `invalid` / `expired` from the chain; there
is no client "sold" call.

### 5. Buys ship disabled

`BUYS_ENABLED` defaults to `false`: `/v1/buy/*` answers 503 `buys_paused` at the HTTP layer and the service refuses
again if called directly. It flips to `true` only after (a) the signet checklist in SETTLEMENT.md §7 (the five
wallet/chain items plus P2WPKH, watcher and royalty) is done with real wallets, (b) an external security review of
settlement signs off, and (c) the owner has set `TREASURY_ADDRESS` and `ROYALTY_BPS`. Reason: every unit test signs
with `@scure/btc-signer`, not with UniSat/Xverse; the class of bug that paused buys (a signature the wallet produced
on a transaction nobody inspected) is exactly what unit tests with our own signer cannot rule out.

### 6. Royalty

When `ROYALTY_BPS > 0`, output #3 pays `floor(price × bps / 10 000)` to `TREASURY_ADDRESS`, on top of the price
(the seller always receives exactly the listed price). Config refuses a royalty without a valid treasury address;
listings whose royalty would be dust are refused at listing time.

## Alternatives considered

- **Keep the legacy app and fix it in place.** Two FIFO implementations and two BIP-322 stacks to keep in sync, no
  contracts, no catalog entry; the mint's Register would stay invisible to it. Rejected.
- **Index 1 (one padding input).** Leaves no output to absorb rounding before the inscription output; index 2 matches
  the convention major ordinals marketplaces use. Rejected.
- **Hide the inscription input from the buyer's wallet (the legacy trick).** It is how the defect shipped. Rejected
  permanently.
- **Rely on `checkInscriptionCoverage` (inscription inputs first).** Would require the inscription at input 0, which
  forces the price to output 0 or breaks the seller's SINGLE commitment. Explicit destination assertion instead.
- **Enable buys once unit tests pass.** See §5.

## Consequences

- The club's exchange is in the catalog, contract-tested (routes, error codes, status enums, live responses and
  events), and uses the same FIFO and identity code as the mint.
- The service stores sellers' 0x83 signatures while listings are open (wiped on close, never returned). A signature
  stays valid on chain until the outpoint is spent, so a leaked database could let someone complete an open listing
  at its listed price; moving the Degent is the only on-chain cancel. The UI should offer it for high-value listings.
- Production needs `DATABASE_PATH`, `MINT_API_URL` (Register), an ord serving `/r/inscription`, `/r/utxo`,
  `/r/parents`, and an esplora. No secrets: the service holds no keys.
- `apps/web` gains marketplace screens in a later pass, following the UI contract in the market README (listing card,
  list flow, buy flow that shows the real transaction, paused banner).
- Owner actions (roadmap): p3.11 `TREASURY_ADDRESS`, p3.12 `ROYALTY_BPS`, p3.4 signet trades, p3.5 external review,
  p3.13 `BUYS_ENABLED=true`.
