# Settlement design: how a Degent changes hands

This is the design of `@bsh/degent-market`'s settlement engine (`src/domain/settlement/`), ported from the
legacy Degent-Marketplace (`src/psbt/`, branch `claude/magical-einstein-ugdy2r`) and decided in
[ADR-0008](../../../../../docs/adr/0008-first-party-marketplace-settlement.md). It explains the transaction layout,
why the seller signs with `SIGHASH_SINGLE|ANYONECANPAY` at input 2, the threat model, and what has to be proven
on signet before anyone sets `BUYS_ENABLED=true`.

## 1. Ordinal theory in one paragraph

Sats are numbered. A transaction's input sats are laid end to end in input order, the outputs are filled from
that sequence in output order, and the leftover tail is the fee. An inscription is bound to one sat, so it lives
in whichever output receives that sat (**first in, first out**). This service does **not** implement that rule:
it calls `@bsh/inscription` (`assertNoInscriptionBurn` / `assignSats`, with `inscriptionDestination` in the tests),
the same implementation the mint and the platform tests use (`deps/scribbit/platform/inscription/README.md`,
"Sat assignment"). One implementation of the maths.

## 2. The defect that paused buys (kept as a regression fixture)

The legacy browser engine built:

```
inputs                        outputs
0  inscription UTXO (seller)  0  price    → seller   ← receives sat #0 of the transaction
1  buyer payment              1  postage  → buyer
                              2  change   → buyer
```

The inscribed sat is the first sat of the transaction, so it went to output 0, the **seller's** payout: the seller
kept the Degent and the price. The buyer's wallet would have warned, but the engine had the buyer sign a
placeholder input with `SIGHASH_ALL|ANYONECANPAY` and transplanted the signature, so no warning appeared; it also
put the tweaked output key in `tap_internal_key` and never verified the seller's signature.
`test/settlement-fifo.test.ts` keeps this layout as a fixture and asserts `inscriptionDestination` sends it to
output 0 (the seller); the guard refuses it.

## 3. The layout

```
 inputs                                       outputs
┌──────────────────────────────────────┐     ┌────────────────────────────────────────────────┐
│ 0  buyer padding #1   (600-1000 sats) │ ──▶ │ 0  padding merge (pad1 + pad2)       → buyer    │
│ 1  buyer padding #2   (600-1000 sats) │     │ 1  postage (= inscription UTXO value) → buyer   │ ◀─ inscription sat
│ 2  INSCRIPTION UTXO   (seller, 0x83)  │ ──▶ │ 2  price                             → seller   │ ◀─ only output the seller signs
│ 3… buyer payment UTXO(s)              │     │ 3  royalty  (ROYALTY_BPS > 0)        → treasury │
└──────────────────────────────────────┘     │ 4  change   (omitted when dust)      → buyer    │
                                              └────────────────────────────────────────────────┘
                              fee = Σ inputs − Σ outputs   (paid by the buyer)
```

FIFO: sats `[0, pad1+pad2)` fill output 0 exactly; `[pad1+pad2, pad1+pad2+postage)`, the whole inscription UTXO,
fill output 1 exactly, so the inscribed sat keeps its offset inside output 1, the buyer's. The royalty is
`floor(price × ROYALTY_BPS / 10 000)` (`royaltyFor` in `@bsh/degent-market-sdk`), paid by the buyer on top of
the price; the seller always receives exactly the listed price.

The guard (`src/domain/settlement/fifo.ts`) asserts, with `@bsh/inscription`:

1. no inscription is burned to fee (`assertNoInscriptionBurn`);
2. the inscription lands in **output 1** at its original offset;
3. output 1 pays the **buyer's** script and carries exactly the postage.

It runs **before any buy PSBT is returned** (`buildBuyerPsbt`) and **again on the exact raw bytes before
broadcast** (`assertRawInscriptionToBuyer`, input values taken from the session's committed prevouts, matched by
outpoint). The padding layout deliberately puts funding inputs ahead of the inscription, so the platform's
burn-proof invariant `checkInscriptionCoverage` (inscription inputs first) does not hold by construction; that is
why the destination is asserted explicitly on every purchase instead.

### Why the seller signs input 2 with SIGHASH_SINGLE | ANYONECANPAY (0x83)

- `ANYONECANPAY`: the signature commits to the seller's own input only (outpoint, amount, script, sequence);
  anybody may add inputs.
- `SINGLE`: it commits to the output **at the same index** only (`price → seller`); anybody may add other outputs.

Together they let the seller sign once, offline, and any buyer complete the transaction later, while the seller is
guaranteed exactly `price` at their own address. BIP341 also commits to the **input index** for taproot, so the
seller must sign at the index the inscription will occupy in the final transaction:

- index 0 is ruled out: the price output would be output 0 and receive the inscription (the defect above);
- index 1 would leave one padding input and the inscription output at index 0, nothing to absorb rounding;
- **index 2** with two padding inputs gives outputs 0 and 1 to the buyer, keeps the merged padding output ≥ 1 200
  sats (above dust; it can be split into fresh padding next time) and matches the index-2 convention of the large
  ordinals marketplaces, so third-party tooling can reason about it.

The mint's reveals use 0x81 (`ALL|ANYONECANPAY`, ADR-0005) because there the signer knows every output up front. A
listing cannot: the buyer's padding, payment, change and the royalty are unknown when the seller signs, so
`SINGLE` is the only mode that lets the seller commit to their payment and nothing else.

The seller's template PSBT has 3 inputs / 3 outputs. Inputs 0/1 and outputs 0/1 are placeholders (zero txid,
600 sats to the seller's own script), never signed or broadcast; wallets need `witness_utxo` on every input to
compute a taproot sighash. `tap_internal_key` is the **untweaked** key from `getPublicKey()`, checked to derive the
seller's address (`paymentForOwner`).

### Verification

- **Create:** the service rebuilds the template and requires the signed PSBT's unsigned transaction to be
  byte-identical, input #2 = the listed outpoint, output #2 = price to the seller, sighash byte 0x83; then it
  verifies the signature: Schnorr over the BIP341 digest against the **output key** in the scriptPubKey (what
  consensus checks) for taproot, ECDSA over the BIP143 digest for P2WPKH.
- **Buy:** the same signature is re-verified against the assembled purchase before the PSBT is returned.
- **Submit:** the wallet's PSBT must have the byte-identical unsigned transaction; only signature material is
  merged into the service's copy; the guard runs again on the raw bytes; the listing is re-validated.

### Fees, padding, coin selection

`estimateVsize` (worst-case per script type) × a mempool.space tier (economy / normal / fast, never below the
minimum), exact-decimal `feeForVsize`. Coin selection takes the buyer's confirmed UTXOs largest first (≤ 20) until
`price + royalty + fee` is covered; change below dust goes to the miner. Tests assert the signed effective rate is
never below the requested rate and within ~8 % above it. Without two padding UTXOs (600–1000 sats), `prepare`
returns a self-transfer creating them (`kind: dummies`); the buy is a second round. Padding and payment UTXOs are
filtered by the wallet's inscription list and by ord (`/r/utxo/{outpoint}`, `UTXO_SAFETY_CHECK`), so an inscribed
sat is never spent as payment.

## 4. Listing validity and the watcher

A listing is valid while: the outpoint is unspent (esplora outspend), ord reports the inscription at that outpoint
held by the seller, the inscription is a Degent (roster Gallery member or parent-linked child, via the mint's
Register), and `expiresAt` (≤ 30 days) has not passed. Checked on prepare, create, buy prepare, buy submit, and by
the settlement watcher every `WATCHER_INTERVAL_MS`:

```
active  ─ outpoint spent by a tx paying the seller the price ─▶ sold
active  ─ outpoint spent by anything else ────────────────────▶ invalid
active  ─ ord: moved / other owner / gone ────────────────────▶ invalid
active  ─ expiresAt passed ───────────────────────────────────▶ expired
active  ─ seller signs a `cancel` challenge ───────────────────▶ cancelled
active  ─ this service broadcasts a purchase ─────────────────▶ pending
pending ─ spend visible (paying the seller) ──────────────────▶ sold, otherwise invalid
pending ─ nothing seen for PENDING_TIMEOUT_MS ────────────────▶ active
```

Every transition publishes `degent.market.listing.{status}` (`contracts/asyncapi/degent-market.yaml`). Entering a
terminal status wipes the stored seller signature.

## 5. Threat model

| Threat | Mitigation |
|---|---|
| Inscription routed to the wrong output (seller, fee, another buyer script) | `@bsh/inscription` FIFO guard before a PSBT leaves the service and on the raw bytes before broadcast; the legacy layout is a regression fixture |
| Seller signature forged, for another price, or from another key | Byte-identical template check + Schnorr/ECDSA verification on create and on the real purchase |
| Listing someone else's inscription | ord ownership + location check, and a SIWB `list` challenge (BIP-322, `@bsh/identity`) bound to inscription + price + address, single use, 10-minute TTL |
| Listing a non-Degent | Membership port (mint Register: Gallery + approved, parent-linked children); 403 `not_a_degent` |
| Cancel by a third party | SIWB `cancel` challenge; the seller address must match the listing |
| Fake "sold" to hide a listing | No sold endpoint; the watcher derives it from the chain |
| Buyer signs a transaction they did not see | No placeholder trick: the buyer signs the real transaction; `summary.inputs/outputs` lists every input and output |
| Client alters the PSBT between prepare and submit | Unsigned-transaction byte comparison; only signatures merged; guard re-run on the raw bytes |
| Spending an inscribed UTXO as payment | Wallet exclusion list + ord `/r/utxo` check; the inscription outpoint and padding excluded explicitly |
| Stale listing (inscription moved) | Validity check before every build/broadcast; the watcher marks it `invalid` |
| Buy session replay / double submit | Sessions are single-use (atomic claim), expire after `BUY_SESSION_TTL_SECONDS` |
| A cancelled listing's signature reused | The service wipes it on any terminal status and never returns it. **Residual:** a 0x83 signature is valid until the outpoint is spent; anyone who obtained it (e.g. a database leak before cancellation) could complete the sale at the listed price. The only on-chain cancel is moving the inscription; the UI should offer "cancel on chain" for high-value listings |
| Custody | None: the service holds no keys; seller and buyer sign in their wallets |

Not mitigated in this phase: front-running between buyers (any buyer may complete a listing, by design); RBF of a
pending purchase by the buyer (the watcher re-opens the listing after the timeout); fee sniping on a pending
purchase.

## 6. What changed from the legacy engine

- TypeScript strict, ports and adapters; zod-validated bodies; Hono instead of Express; no static site.
- The local FIFO calculator is gone; `@bsh/inscription` decides, with a stronger guard (buyer script + exact postage + offset).
- `bip322-js` is gone; SIWB challenges and BIP-322 verification come from `@bsh/identity`; nonces are single use
  and consumed only after the signature verifies (node:sqlite or memory `NonceStore`).
- Collection membership comes from the mint's Register (via `@bsh/degent-mint-sdk`) instead of a bundled JSON.
- `pending` listings cannot be cancelled; closed listings drop the stored signature.

## 7. What must be verified on signet before BUYS_ENABLED=true

Everything above is unit-tested against `@scure/btc-signer`'s signer and fakes, never against a real wallet or
chain. `BUYS_ENABLED` stays `false` (the default) until each item is ticked off on signet (`NETWORK=signet`, an ord
indexer that covers signet, funded UniSat signet accounts) **and** an external review signs off (roadmap p3.5).

The five unverified items carried over from the legacy README / SETTLEMENT.md:

1. **UniSat signs the listing template**: it accepts the 3-input template with two zero-txid placeholder inputs and
   signs input #2 with `sighashTypes: [0x83]`, `autoFinalized: false`, returning a 65-byte `tapKeySig`. (Fallback if
   it rejects the placeholders: duplicate the seller's own inscription outpoint in the placeholder slots; also not
   committed to under ANYONECANPAY.)
2. **UniSat's `getPublicKey()`** for a taproot account yields the key that `p2tr(xonly)` maps to the connected
   address (the `paymentForOwner` check).
3. **UniSat signs the buyer inputs** of the assembled purchase with `autoFinalized: true`, returning
   `finalScriptWitness` for each; the merged transaction is accepted by `mempool.space/signet/api/tx`.
4. **The confirmed purchase shows the inscription at output #1** in the indexer (`/r/inscription/{id}` →
   `satpoint = <buytxid>:1:<offset>`).
5. **The padding round trip**: no small UTXOs → split tx → confirm → buy.

Also to exercise before enabling (legacy items 6–8): a P2WPKH (`bc1q`) seller listing and purchase; the watcher
flipping a listing to `sold` from the live outspend endpoint and to `invalid` when the seller moves the inscription;
a royalty output with a real `TREASURY_ADDRESS` and `ROYALTY_BPS > 0`. Other wallets (Xverse, Leather, OKX, Magic
Eden via `@bsh/wallet-kit`) each need their own round of items 1–3.

Owner decisions before enabling: `TREASURY_ADDRESS`, `ROYALTY_BPS`, the production ord indexer, and the external
reviewer.
