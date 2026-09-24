# ADR-0005: Strict reveals (SIGHASH_ALL|ANYONECANPAY), user-held rescue key, three tiers by content bytes, block-lane weight budget

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** team-degent (product owner decided the tier table), platform (`@bsh/inscription` pin 9298e7f)
- **Components:** `@bsh/inscription` (platform), `@bsh/degent-mint-sdk`, `@bsh/degent-mint`, `@bsh/degent-web`, `@bsh/degent-market`
- **Supersedes / Related:** supersedes parts of [ADR-0002](0002-degent-mint-architecture.md): §1 (tier table), §2
  (sighash 0x83, "K_e is discarded", replay rescue) and §6 (`rescue_available` semantics). ADR-0002 §3 (policy
  signer), §4 and §5 stand. Platform side: `deps/scribbit/platform/inscription/README.md` "Security model".

## Context

ADR-0002 had the browser sign the reveal's commit input with `SIGHASH_SINGLE | ANYONECANPAY` (0x83). That
signature covers the commit input and only the output at its own index (the child). It was chosen because the
same signature validates in `[commit] → [child]`, so the half-signed PSBT doubled as the rescue transaction and
`K_e` could be thrown away.

The platform audit (pin 9298e7f) found what 0x83 leaves open to anyone holding the half-signed PSBT (the service,
a database leak, or a mempool observer after a rescue broadcast):

- **Fee skimming:** extra outputs at index ≥ 2 can take part of `commitValue − postage`.
- **Inscription re-targeting (the redirect gap):** a holder can put *their own* input at index 0 with a value that
  differs from their output 0. ord places the new inscription on the first sat of the envelope input, i.e. at
  offset `value(input 0)`; if output 0 is larger than input 0, the inscribed sat falls into output 0, which the
  holder controls. The user's child output still receives its postage, but not the Degent.

Separately, the product owner fixed the tiers by content size, and the old two-tier table (≤ ~390 KB vs "block")
conflated two different things: what the user buys (bytes) and how the reveal is relayed (weight).

## Decision

### 1. Reveals are signed SIGHASH_ALL | ANYONECANPAY (0x81), with the parent return pre-committed

- The browser fetches `collectionAddress` and `parentValueSats` from `GET /v1/config` and builds
  `[commit] → [parent return (collectionAddress, parentValueSats), child (recipient, postage)]`, signing the commit
  input with **0x81**: every output is covered, the other inputs are not.
- The service inserts the parent input at index 0 (`attachParent`, which only asserts the already-signed output 0).
  ANYONECANPAY does not commit to the input index, so moving the commit input to index 1 leaves the digest intact.
- The service verifies the PSBT with `verifyHalfSignedReveal({ expectedSighash: 'all_anyonecanpay',
  expectedParentReturnAddress: collectionAddress, expectedParentValue: parentValueSats, ... })` before storing it.
  0x83 reveals are refused.
- `parentValueSats` is a service constant (`PARENT_VALUE_SATS`, default 10,000). Startup refuses a
  `PARENT_OUTPOINT` of another value, and the worker pauses reveals (and logs) if the stored parent UTXO's value
  ever differs, rather than building a transaction the browser's signature cannot satisfy.
- The **policy signer's exact-shape checks are unchanged** (ADR-0002 §3 plus the "parent return == parent input
  value exactly" tightening). They are now defence in depth: the browser's signature already pins both outputs.

**Why 0x81 closes the redirect gap.** With ALL, the signature commits to `sha_outputs`: output 0 is fixed to
(collection address, `parentValueSats`) and output 1 to (recipient, postage); no output can be added, removed,
resized or swapped. The only freedom left to a PSBT holder is input 0 (outpoint and value). For the transaction to
be co-signed by the policy signer, input 0 must be the parent UTXO with value == output 0. Consider the attacker's
best case anyway: they fund their own input 0 of value `v ≠ parentValueSats`. The inscribed sat sits at offset `v`;
with `v < parentValueSats` it lands in output 0, which is signed to the **collection address** (company custody,
recoverable by support); with `v > parentValueSats` it lands later in output 1 or in the fee. In no case can it land
in an output the attacker controls, because there is no such output, and the attacker pays for the attempt. This
residual griefing needs the PSBT (kept encrypted, never returned) plus the attacker's own funds, and it cannot
redirect value to them — unlike 0x83, where the same move was theft. Fee skimming is gone for the same reason
(no extra outputs).

### 2. Self-rescue: the user keeps K_e and re-signs `[commit] → [child]`

- A 0x81 half-signed reveal cannot be broadcast without the parent (output 0 would be unfunded), so the old
  "replay the PSBT" rescue no longer exists. Rescue is a **fresh** transaction the user signs:
  `@bsh/inscription.buildResignedRescue` spends the commit output via the same tapleaf with `K_e`, SIGHASH_DEFAULT,
  paying `postage` to the recipient; the rest of the commit value is fee.
- The browser therefore **keeps K_e in the user's recovery bundle** (v2: `revealPrivkey` hex, the exact content
  bytes base64, parent id, commit outpoint/value, recipient, postage, order token). It is shown as copyable JSON
  with a clear note, saved to localStorage before the wallet is asked to sign, and wiped from tab memory.
- `GET /v1/orders/{id}/rescue` (bearer token, only in `rescue_available`) now returns the **inputs** the browser
  needs — commit outpoint and value, content type/length/hash, parent id, recipient, reveal pubkey, postage, exact
  rescue weight, the rescue's implied fee rate and a suggested fee rate — never a transaction. The browser checks
  them against its bundle (any disagreement: refuse to sign), re-signs locally and broadcasts via the wallet's
  `pushTx` or esplora. With the service gone, the bundle alone is enough.

**Why keeping K_e in the user's bundle is safe.** K_e is an x-only key used in exactly one place: the inscription
tapscript `<K_e> OP_CHECKSIG …` of **this order's commit output**, which the user funded, under a NUMS internal
key (no key path). It is not derived from, and cannot sign for, any wallet key; it controls no other UTXO. Whoever
holds it can spend that one commit output — which is the user's own money — and any spend still inscribes the
envelope that is committed in the tapleaf. The worst a thief of the bundle can do is spend the commit output
before the service reveals: the fee is fixed by the commit value, and they could send the child to their own
address, which is why the bundle must stay private (the UI says so). That is the same exposure the user already
has with their payment coins in the same browser, and strictly less than any custodial design: the service never
sees K_e, so a service compromise cannot touch the commit. Versus ADR-0002 we trade "K_e is discarded" for "no
third party holding a PSBT can redirect the inscription"; the key moves from nobody to the one party whose funds
it guards.

### 3. Three tiers by content bytes (product), lanes by weight (transport)

| Tier (`Tier`) | Label | Content bytes | Usual lane | Shares a block? |
|---|---|---|---|---|
| `standard` | Standard Degent | 200,000 – 400,000 | standard | yes (many per block) |
| `large` | Large Degent | 400,001 – 3,499,999 | block | yes, within the weight budget |
| `fullblock` | Full Block Degent | 3,500,000 – 3,900,000 | block | **never** |

- The tier is a product decision on bytes, validated by `@bsh/degent-mint-sdk` (`tierForSize`, `validateContentMeta`).
  Service fees are per tier (`SERVICE_FEE_SATS_{STANDARD,LARGE,FULLBLOCK}`).
- The **lane is transport, decided by the exact reveal weight**: ≤ 400,000 WU (`MAX_STANDARD_TX_WEIGHT`) is the
  standard lane, else the block lane (≤ 3,990,000 WU). The envelope adds ~3.3 kWU to the bytes, so a Standard
  Degent above ~396,700 bytes (i.e. 397–400 KB) weighs more than 400,000 WU and **travels the block lane**. The quote's
  `lane` says so, and the front end states it in Create (before ordering) and in Quote.

### 4. Block lane: a per-block weight budget

- The block lane packs reveals into block slots of **3,990,000 WU**. Orders are packed greedily in queue order
  (no overtaking): an order joins the current slot if its weight fits; a **Full Block Degent always opens its own
  slot and closes it**. Several Large Degents (e.g. three of ~1.2 M WU) are revealed into the same block.
- The worker dispatches block-lane reveals while the in-flight (revealing + unconfirmed) weight plus the next
  order's weight fits the budget and neither is a Full Block Degent; the first order that does not fit stops the
  lane until the next block (`fitsInFlight`). Block reveals chain on each other's parent output through the same
  relay; standard reveals still never chain on an unconfirmed block-lane parent.
- Queue position = block slot index (`packBlockSlots` / `blockSlotOf` in the SDK, the same maths for UI and
  service); ETA = slot × ~10 min, an estimate. `GET /v1/queue` reports `weightBudget` and `inFlightWeight`.
  New block-lane orders are refused (`queue_full`) when their slot's ETA would exceed 80% of the rescue timeout.

### 5. Marketplace: padded purchase layout (related fix)

`@bsh/degent-market` builds listings (seller signs the inscription input 0x83, paid at the same index) and
purchases with two buyer padding inputs **before** the inscription input and a padding-merge output **before**
the buyer's receive output, so that under ordinal FIFO the inscribed sat lands in the buyer's output. A sat-range
FIFO simulator proves placement for a matrix of values and reproduces the audited bug (inscription input first →
the sat lands in the seller's payment output).

## Alternatives considered

- **Keep 0x83 and keep the PSBT secret.** Relies on confidentiality of a document the service, its database and
  (after a rescue broadcast) the mempool all see. Rejected: the redirect gap is structural.
- **0x81 but K_e discarded, rescue signed by the service.** Would require the service to hold K_e: custodial.
- **Pre-sign a rescue at payment time.** A pre-signed `[commit] → [child]` with SIGHASH_DEFAULT is itself a
  broadcastable transaction that races the parent reveal from the moment it exists and must be protected like a
  key; it also fixes the rescue fee rate months in advance. Keeping K_e gives the same guarantee with more control.
- **Tiers by weight.** Users see bytes, and the relay limit is not a product boundary. We keep the owner's byte
  tiers and are honest about the lane.
- **One reveal per block for the whole block lane (ADR-0002).** Wastes most of a block on Large Degents and
  lengthens the queue; the budget is what the chain actually limits.

## Consequences

- The recovery bundle is now sensitive in a new way (it holds a key); the UI explains exactly what the key can and
  cannot do and still makes the user confirm they kept a copy before the wallet signs.
- `GET /rescue` is a contract change (inputs instead of `hex`); `ServiceConfig` gains `parentValueSats`;
  `TierRule` gains `sharesBlock`; `LaneQueue` gains `weightBudget` / `inFlightWeight`; `Tier` is
  `standard | large | fullblock`. The AsyncAPI event is unchanged (it carries `lane`, not tier).
- The parent UTXO's value is now a protocol constant for the collection. Changing it means draining the queue and
  rotating like a key (RUNBOOK §2).
- Operations must watch block-lane relay capacity: several non-standard reveals per block through Libre Relay /
  Slipstream instead of one.
- 0x83 support can be removed from `@bsh/inscription` one release later; this product never accepts it.
