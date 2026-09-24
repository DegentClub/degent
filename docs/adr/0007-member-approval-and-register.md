# ADR-0007: Member approval gates the parent link; the Register is the club's roll

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** club owner, team-degent
- **Components:** `@bsh/degent-mint`, `@bsh/degent-web`, `@bsh/degent-mint-sdk`; consumes `@bsh/identity` (platform)
- **Supersedes / Related:** extends [ADR-0002](0002-degent-mint-architecture.md) §5–§6; self-rescue as re-defined by
  [ADR-0005](0005-sighash-all-anyonecanpay-reveals.md) (0x81 reveals, re-signed rescue); platform ADR-0004 (repo
  split, contract ownership); `docs/REGISTER.md`; `roadmap.yaml` p1.9–p1.12, p2.1–p2.10, p3.8–p3.9

## Context

ADR-0002 made minting automatic: an `ArtReview` port filters art before payment, the browser pre-signs a reveal, and
the service attaches the club's parent inscription and co-signs it. Nobody human was in the loop, and **the parent
link was the only membership proof** — whoever passed the automated filter and paid became a Degent.

The owner's requirement changed that: the mint is a four-stage pipeline **Design → Mint → Confirm → Approve**, and
**every new Degent must be manually approved by existing club members before it becomes a Degent**. Three facts
shape the design:

1. Membership *is* the parent link, applied at reveal (ADR-0002 §2, §5). Whatever gates the parent-linked reveal
   gates membership; there is no separate list to keep.
2. The user has already paid by the time the commit is on chain, and the service is non-custodial: the funds sit in a
   commit output only the user's ephemeral key K_e can spend. A rejection after payment must therefore never
   strand funds; the self-rescue path (ADR-0002 §2, re-signed with K_e since ADR-0005) already exists for that.
3. "Existing club members" must be recognisable without trusting a database. Today the club is the 4,112 Gallery
   inscriptions in the hand-maintained marketplace roster; on-chain membership records (parent, Gallery, children,
   `docs/REGISTER.md`) do not exist yet. Holders can prove control of an address with BIP-322, which the platform
   already implements (`@bsh/identity`: SIWB challenges, BIP-322 simple verification, nonces, sessions).

## Decision

### 1. Approval gates the parent-linked reveal; automated review stays as the pre-payment filter

The `ArtReview` step (rules + optional vision model) is unchanged and still runs before anything is payable
(stage **Design**). Member approval is a second, human gate placed after the commit is confirmed and before the
service leases the parent (stage **Approve**). Because the parent link is applied at reveal, an approved order is a
Degent and a declined one is an ordinary inscription — no other list decides.

### 2. New order states

After the commit is funded:

```
paid → confirming (commit tx unconfirmed)
     → member_review (commit confirmed with CONFIRMATIONS; members vote)
       → queued (APPROVAL_QUORUM reached; Degent number assigned) → revealing → … as ADR-0002
       → declined (DECLINE_QUORUM reached) → revealed (user self-rescued, no parent)
       → rescue_available (no decision within REVIEW_SLA_SECONDS, default 14 days)
paid | confirming → rescue_available after rescueAfterSeconds from payment (as before)
queued | revealing → rescue_available after rescueAfterSeconds from *approval* (the club's deliberation time is
not the lane's fault)
```

`declined` immediately offers self-rescue: `GET /v1/orders/{id}/rescue` returns the rescue parameters, the browser
re-signs the parent-less `[commit] → [child]` with K_e from the recovery bundle (ADR-0005), and the front end
presents "keep your inscription". The existing `rescue_available` semantics are unchanged. Orders in
`member_review` do not occupy a lane slot (queue ETAs stay honest). `TRANSITIONS`, `ACTIVE_STATUSES`,
`WAITING_FOR_LANE`, the SDK `OrderStatus` and both contracts carry the three new statuses.

### 3. Who is a member, and how they vote

- **Member = current holder of a Degent.** Until the on-chain Register exists, that means: the current owner of a
  Gallery inscription (`data/roster.json`, 4,112 entries built from the marketplace manifest by
  `scripts/build-roster.mjs`) or of a delivered, parent-linked child minted here. A `HolderRegistry` port answers
  `isHolder(address)` / `holderOf(n)`; the `roster-chain` adapter reads ownership from ord/esplora (injectable
  fetch), the in-memory adapter serves tests and regtest.
- **Sign-in is SIWB via `@bsh/identity`**: `POST /v1/auth/challenge` issues a domain-bound, single-use challenge,
  the wallet signs it (BIP-322 simple through `@bsh/wallet-kit.signMessage`), `POST /v1/auth/verify` checks it with
  `verifySignIn`, confirms the address holds a Degent, and issues an EdDSA session (`SessionKeyRing`, key from
  `SESSION_KEY`). No signature code is written in this repository.
- **A vote is itself a BIP-322 signature** of the statement `Approve Degent order <id> (<inscriptionId or
  contentSha256>)` (or `Decline …`), built by one function in the SDK and rebuilt/compared by the service. Votes are
  stored with the signature and published (`GET /v1/orders/{id}/votes`) with the voter's Degent number, never the
  address, so anyone can verify the record. Rules: one vote per address per order; the voter must hold a Degent at
  vote time (a sold Degent revokes the session); a voter may not vote on an order paying their own address; votes
  are accepted only in `member_review`.
- **Quorums** are settings: `APPROVAL_QUORUM` (default 3) and `DECLINE_QUORUM` (default 3); approval is checked
  first. **Review SLA** `REVIEW_SLA_SECONDS` (default 14 days) hands undecided orders to self-rescue.

### 4. Numbering and the Register

- The Gallery is Degents #1–#4112. An approved order is assigned `4112 + rank`, where rank is the order of
  approval (persisted, monotonic `approval.approvedCount`); a decline consumes no number. The number is assigned at
  quorum and travels with the order (`degentNumber`, `degent.mint.order.queued` detail).
- The Register API is public and read-only: `GET /v1/register` (parent, gallery id, count, bytes, pending),
  `/v1/register/{n}`, `/v1/register/holder/{address}` (the Telegram gate's question), `/v1/register/verify/{id}`
  (`via: gallery | child`), `/v1/explorer` (paginated, sortable, searchable, image URLs via ord `/content`) and
  `/v1/stats` (minted/10,000, bytes, median, mints per week, size histogram, approvals throughput, top holders).
  A delivered, parent-linked child joins the Register automatically; a rescued (parent-less) inscription never does.
- `scripts/register-batch.mjs` emits newly approved members with their approver signatures as JSON for the owner to
  inscribe as a child of the parent (`docs/REGISTER.md` §1.3), so the on-chain record carries the proof of admission.

### 5. Contracts

Contract first: `contracts/openapi/degent-mint.yaml` gains the routes and schemas above; `contracts/asyncapi/
degent-mint.yaml` gains the statuses. The shared topic `degent.mint.order.{status}` is owned by the platform
(`deps/scribbit/contracts/asyncapi/platform-events.yaml`). Shared topics are changed platform-first: while the pin
lagged, our status enum was a **superset** of the platform's and `contract.test.ts` asserted exactly that (platform
values ⊆ ours, extras limited to `confirming`, `member_review`, `declined`). The platform adopted them in topic
1.1.0 (scribbit `9c69557`, pinned here at `401682f`), so the test asserts equality again; `pnpm contracts:diff`
prints any future delta.

## Alternatives considered

- **Approve before payment (vote on the art, then pay).** Cleaner for the user's money, but the members would vote on
  bytes that might never be inscribed, the review queue would fill with unfunded submissions, and the vote could not
  bind to the inscription id. Confirmed funding is a cheap sybil filter; self-rescue makes post-payment rejection
  safe.
- **A separate on-chain "approved" list instead of gating the parent.** Two sources of truth; the parent link is
  already what every indexer checks (ADR-0002 §5).
- **Sessions from a wallet signature only (no SIWB).** Replayable and not domain-bound. The platform's SIWB exists
  and is tested; reuse.
- **Owner-only approval.** A single key is a single point of failure and contradicts "decentralized gentlemen". A
  member quorum with public, signed votes is auditable; the owner still controls the parent key (policy signer).
- **Count orders in `member_review` towards lane queue ETAs.** Rejected: 14 days of possible deliberation would make
  every ETA meaningless.

## Consequences

- A paid order can now wait up to 14 days for humans. The Track page shows the four stages, the live tally ("2 of 3
  members have approved") and the deadline; the block-lane `queue_full` guard is unchanged.
- The mint needs three new secrets/settings on mainnet: `SIWB_DOMAIN`, `SESSION_KEY` (path
  `services/degent-mint/session-key`), and `HOLDER_REGISTRY=roster-chain` with an ord that serves `/r/inscription`
  and `/r/utxo`. `APPROVAL_QUORUM`, `DECLINE_QUORUM`, `REVIEW_SLA_SECONDS` tune the club.
- Ownership lookups hit ord per Degent (cached 60 s; stats cached 10 min). A club-run ord is expected (p2.13).
- The roster is a committed JSON (`products/degent/services/mint/data/roster.json`) until the Gallery inscription
  exists; `GALLERY_INSCRIPTION_ID` then surfaces it in `GET /v1/register`.

## Follow-ups

1. ~~**Platform PR (DegentClub/scribbit):** add `confirming`, `member_review`, `declined` to
   `contracts/asyncapi/platform-events.yaml` and `platform/events/src/platform-topics.ts` (additive →
   `x-topic-version` 1.1.0); then bump the pin and tighten `contract.test.ts` from superset to equality.~~
   Done: scribbit `9c69557` (topic 1.1.0), pin bumped to `401682f`, test tightened. The same pin brought
   `@bsh/inscription.inscriptionDestination` (ordinal FIFO), which the worker now uses to locate the delivered
   child instead of a hard-coded output index.
2. Owner: inscribe the Club parent and the signed Gallery of the 4,112 (`docs/REGISTER.md` §1.1–1.2); set
   `PARENT_INSCRIPTION_ID`, `GALLERY_INSCRIPTION_ID`.
3. Run `scripts/build-roster.mjs --indexer <club ord>` to fill heights/timestamps (mints-per-week for the Gallery).
4. Telegram gate service (roadmap p3.6) consuming `GET /v1/register/holder/{address}` and the `/verify` page's
   `{token, address, message, signature}`.
5. Register updates: inscribe `register-batch.mjs` output as children of the parent on a cadence (p3.9 → owner).
