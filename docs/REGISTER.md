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
{ "name": "Decentralized Gentlemen Club", "charter": "10000" }
```

(An earlier draft also carried `"register": "<Gallery id>"`. Inscription metadata is immutable and the Gallery can only
be inscribed after the parent, so the pointer is not written: the Gallery is the parent's signed child, found with
ord `/r/children/<parent>` and announced as `GALLERY_INSCRIPTION_ID`, `GET /v1/register` → `gallery`.) The parent is
inscribed to the owner's ord wallet, the Gallery inscribed with `--parent`, and only then is the parent sent to the
collection address; step by step in [LAUNCH-CHAIN-SETUP.md](LAUNCH-CHAIN-SETUP.md), prepared by
`scripts/prepare-parent.mjs`.

### 1.2 The Gallery (existing 4,112)
The first 4,112 Degents were inscribed before the parent existed, so they cannot be its children. They are recorded instead by one **Gallery inscription**, a child of the parent, whose content is a JSON document:

```json
{ "version": 1, "members": [ { "n": 1, "id": "add1a5…bfd3i0" }, … ] }
```

The Gallery is signed: the metadata includes a BIP-322 signature over `sha256(content)` by the club's announced signing address, so a forked gallery cannot impersonate it. Additions after 4,112 do not touch the Gallery; they use 1.3.

Exact form (`scripts/prepare-gallery.mjs` builds it, `chain-setup verify-gallery` checks it): the content is the compact
JSON above (no whitespace, members ordered by `n`, 4,112 unique ids, no trailing newline); the signed message is the
single ASCII line

```
degent.club Gallery v1: 4112 members, sha256 <sha256(content), lowercase hex>, parent <parent inscription id>
```

and the CBOR metadata is `{ kind: "degent.club/gallery", version: 1, parent, count, sha256, message, signer, signature }`
(BIP-322 simple, base64). Binding the parent id into the message keeps the signature from being replayed under another parent.

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

### 2.1 One certified count

The site has shown three conflicting figures (site-spec "Known defects"): 4,027 minted / 1,470 MB on the site, 4,112 in
`collection.json`, 4,113 / 1,508 MB in an internal analysis. `products/degent/services/mint/scripts/reconcile-count.mjs`
settles them:

```sh
node products/degent/services/mint/scripts/reconcile-count.mjs --ord https://<your-ord> --export magic-eden-ids.json --out count-report
```

It counts unique, well-formed ids in the roster (numbers 1..N contiguous), sums ord `content_length` when a URL is given
(cached; otherwise it labels the roster's `sizeKb`×1024 as an estimate), diffs an exported id list, and writes
`count-report.json` + `.md` with one explanation per discrepancy class: `stale-count` / `over-count`, `unit-mismatch`
(MiB or KiB labelled MB), `duplicate-in-roster`, `roster-numbering`, `missing-from-export`, `extra-in-export`,
`export-hygiene`, `size-mismatch-vs-ord`, `ord-unavailable`. From the committed roster alone: **4,112 Degents,
1,544,701,318 bytes = 1,544.7 MB = 1,473.1 MiB** (estimate until re-run against ord). The site's 4,027 is a stale
snapshot (85 members, #4028–#4112, are missing) and its "1,470 MB" is the MiB total of all 4,112; the internal
1,508 "MB" is the KiB sum divided by 1000, and its 4,113 counts one row that is not a Degent. Always publish bytes
with the unit (MB = 10^6) and the source.

### 2.2 What counts as "blockspace"
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
