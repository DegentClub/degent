# The Register — on-chain roster of the Decentralized Gentlemen Club

The Register is how anyone with a Bitcoin node can verify two claims without trusting degent.club:

1. **Membership** — "this inscription is Degent #N".
2. **Scale** — "the club has consumed X bytes of blockspace, more than any other collection".

Today membership lives in a roster JSON (`products/degent/services/mint/data/roster.json`, built from the
marketplace manifest) and, for new mints, in the **members' approval** ([ADR-0007](adr/0007-member-approval-and-register.md)):
the mint only attaches the club parent to an inscription after existing members approved it, so **approval
gates the parent link**, and the parent link is membership. This document specifies how the roll moves on-chain
and what the mint service serves in the meantime.

## 1. Structures

### 1.1 The Club parent
One inscription, held in the club's own ord wallet (cold, multisig-controlled — see *Custody*), whose content is the club charter (a short HTML page) and whose metadata (CBOR, per the ord `--cbor-metadata` flag) carries:

```json
{ "name": "Decentralized Gentlemen Club", "charter": "10000", "register": "<inscription id of the Gallery, filled after 1.2>" }
```

### 1.2 The Gallery (existing 4,112)
The first 4,112 Degents were inscribed before the parent existed, so they cannot be its children. They are recorded instead by one **Gallery inscription**, a child of the parent, whose content is a JSON document:

```json
{ "version": 1, "members": [ { "n": 1, "id": "add1a5…bfd3i0" }, … ] }
```

The Gallery is signed: the metadata includes a BIP-322 signature over `sha256(content)` by the club's announced signing address, so a forked gallery cannot impersonate it. Additions after 4,112 do not touch the Gallery; they use 1.3.

### 1.3 New members (4,113 →)
Every new mint is revealed by the mint service (`@bsh/degent-mint`, ADR-0002) as a **child of the Club parent**:
the service leases the parent UTXO, the policy signer co-signs input 0, and the reveal carries the parent tag —
**only after the members approved the order** (ADR-0007: `member_review → queued`). Membership is then a pure
on-chain fact: `child.parent == club`. An order the members decline is still revealed by its owner through
self-rescue, without the parent — it is an inscription, not a Degent, and never enters the Register.

The Skrybit-API question of the earlier draft is moot: parent-child inscribing is done in-house by the policy
signer (ADR-0002 §3); no third-party inscriber is in the path.

**Register updates.** `products/degent/services/mint/scripts/register-batch.mjs` emits the newly approved members
(`{n, id, via: "child", votes: [{degent, signature, message}]}`) as JSON; the owner inscribes each batch as a child of
the parent so the on-chain record also carries the members' BIP-322 approval signatures.

### 1.4 Numbering
- #1–#4112: as in the Gallery.
- #4113+: `4112 + rank of approval` — assigned by the mint when the approval quorum is reached, persisted and
  monotonic (a declined order consumes no number), and inscribed in the Register update. Ties are impossible:
  quorum events are serialised by the service. (The earlier draft derived numbers from reveal order; approval
  order is chosen so that the number is known — and shown to the minter — before the reveal, and so that a
  standard-lane reveal overtaking a block-lane reveal cannot swap two numbers.)

## 2. Verification (what "verify it with a node" means)

```sh
# membership of one inscription
curl -s https://<your-ord>/r/inscription/<id> | jq '.parents'        # must include the club id
# or for a Gallery member
curl -s https://<your-ord>/r/content/<gallery id> | jq '.members[] | select(.id=="<id>")'

# scale
node scripts/blockspace-query.mjs --collection collection.json --compare compare.json
```

`scripts/blockspace-query.mjs` sums `content_length` over every id from ord's recursive endpoint, caches results, and prints a markdown table. Publish the table and the `compare.json` ids monthly so the comparison is reproducible.

### 2.1 What counts as "blockspace"
Content bytes of the reveal transaction's inscription envelope. This undercounts total weight (envelope overhead, commit tx) by a few percent but is the same measure for every collection, which is what makes the comparison fair. State it that way in public.

## 3. Custody
- Club parent and Gallery are held in a 2-of-3 taproot multisig ord wallet (owner, ops, offline).
- The parent must be spent to inscribe each child batch, so the hot path uses a delegated approach: ord's `--parent` requires the parent UTXO in the signing wallet. Two options:
  a. Batch children daily from the multisig (manual signing ceremony; simple, slow).
  b. Hold the parent in a hot ord wallet with a small balance and sweep the child inscriptions to buyers immediately; the parent itself never leaves. Risk: hot-key compromise lets an attacker mint fake children. Mitigation: publish the parent's expected location and rotate on compromise; the Gallery + signing address remain authoritative for pre-compromise members.
Decision needed from the owner; the roadmap defaults to (b) with monitoring.

## 4. Collection API (shipped — `contracts/openapi/degent-mint.yaml`, served by `@bsh/degent-mint`)
`GET /v1/register` → `{ parent, gallery, count, bytes, pending, updatedAt }`
`GET /v1/register/{n}` → `{ n, id, number, via, bytes, height, sat, owner, contentUrl }` (schema: `schemas/register.schema.json`)
`GET /v1/register/holder/{address}` → `{ address, holder, degents }` (the Telegram gate's question)
`GET /v1/register/verify/{id}` → `{ id, member, via: "gallery" | "child" | null, n }`
`GET /v1/explorer?offset&limit&sort=n|bytes|height&order&q` → paginated members with image URLs (ord `/content`)
`GET /v1/stats` → minted/10,000, total bytes, median, mints per week, size histogram, approvals throughput, top holders

Backed by the roster JSON plus ord (`/r/inscription/<id>` for owners, `/r/utxo/<outpoint>` for holder checks)
and esplora (`/address/<a>/utxo`); ownership answers are cached for 60 s, stats for 10 min. Until the Gallery
inscription exists (`GALLERY_INSCRIPTION_ID`), `gallery` is `null` and the roster file is the Gallery.
