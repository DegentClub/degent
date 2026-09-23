# Settlement design

This document explains how a Degent changes hands, why the transaction is laid
out the way it is, what the old engine got wrong, and what remains to be proven
on signet before `BUYS_ENABLED` can be turned on.

## 1. Ordinal theory in one paragraph

Every satoshi has a serial number. When a transaction is confirmed, the sats of
its inputs are laid end to end in input order, and the outputs are filled from
that sequence in output order; whatever is left over (the fee) goes to the
miner. An inscription is bound to one sat, so the inscription lives in
whichever output receives that sat. This is the **first-in-first-out (FIFO)**
rule, implemented in `src/psbt/ordinals.js#computeOrdinalDestination`.

## 2. The defect that paused buys

The previous engine (`legacy/psbt-unsafe.js`) built this purchase transaction:

```
inputs                        outputs
0  inscription UTXO (seller)  0  price      → seller     ← receives sat #0 of the tx
1  buyer payment              1  postage    → buyer
                              2  change     → buyer
```

The inscribed sat sits at offset 0 of input 0, i.e. it is the very first sat
of the transaction, so it is assigned to output 0 — the **seller's** payout.
The seller ended up with the price *and* the inscription. The buyer's wallet
would normally have warned that an inscription input was being spent in a
suspicious way, but the engine deliberately had the buyer sign against a
zeroed placeholder input (`SIGHASH_ALL|ANYONECANPAY`) and then transplanted the
signature onto the real transaction, so no warning was shown.

`tests/ordinals.test.js` reproduces this layout and asserts the sat lands in
output 0.

## 3. The new layout

```
inputs                                 outputs
0  buyer dummy #1     (≥ 600 sats)     0  dummy merge (d1 + d2)     → buyer
1  buyer dummy #2     (≥ 600 sats)     1  postage (= inscription UTXO) → buyer   ← inscription sat
2  INSCRIPTION UTXO   (seller)         2  price                     → seller   ← only output seller signs
3… buyer payment UTXO(s)               3  royalty (ROYALTY_BPS)     → treasury  (omitted when 0)
                                       4  change                    → buyer     (omitted when dust)
                                            fee = Σ inputs − Σ outputs (buyer pays)
```

FIFO check: sats `[0, d1+d2)` fill output 0 exactly; sats `[d1+d2, d1+d2+postage)`
— the whole inscription UTXO, including the inscribed sat at its offset — fill
output 1 exactly. The builder computes this with `computeOrdinalDestination`
and refuses to produce a PSBT unless the answer is output 1 owned by the buyer.
`POST /api/buy/submit` repeats the check on the exact bytes it broadcasts.

### Why the seller signs at index 2

The seller signs with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (0x83):

* `ANYONECANPAY` — commit to *my* input only; anybody can add inputs.
* `SINGLE` — commit to the output **at the same index** as my input only;
  anybody can add other outputs.

Together they let the seller sign once, offline, and let any buyer complete the
transaction later, while guaranteeing the seller receives exactly `price` at
their own address.

BIP-341 (taproot) sighash additionally commits to the **input index** (and the
input's own outpoint, amount, script and sequence under `ANYONECANPAY`). So the
seller must sign at the index their input will occupy in the final transaction:

* Index 0 is ruled out: the price output would then be output 0, and by FIFO it
  would receive the inscription sat — the original bug.
* Index 1 would need exactly one buyer input before the inscription and would
  put the inscription output at index 0, leaving no slot that can absorb dust
  or rounding before it.
* **Index 2** with two dummy inputs gives outputs 0 and 1 to the buyer, keeps
  the merged-dummy output ≥ 1 200 sats (safely above dust), lets that output be
  split back into two fresh dummies for the next purchase, and matches the
  index-2 convention used by the large ordinals marketplaces.

The seller's template PSBT therefore has three inputs and three outputs. Inputs
0/1 and outputs 0/1 are placeholders (zero txid, 600 sats to the seller's own
script). They are never signed or broadcast; `SINGLE|ANYONECANPAY` does not
commit to them. They exist only because wallets need `witness_utxo` on every
input to compute a taproot sighash, and because the inscription has to be *at
index 2* when it is signed.

### Keys

For a taproot account UniSat derives the address as `p2tr(internalKey)` with no
script tree. The PSBT's `tap_internal_key` must be that **untweaked** x-only key
(`publicKey[1..33]` from `wallet.getPublicKey()`), which the server checks
derives the given address. The old engine put the 32-byte witness program from
the address (the already tweaked output key) in that field.

Verification, on the other hand, uses the output key from the scriptPubKey
directly, exactly as consensus does: `schnorr.verify(sig[0..64],
tapSighash(tx, 2, 0x83), outputKey)`. Native segwit (`bc1q`) sellers are also
supported with ECDSA over the BIP-143 digest; that path is implemented and unit
tested but has not been exercised with a real wallet.

### Fees

`estimateVsize` sums per-type input/output weights (taproot input 57.75 vB with
a 65-byte signature, P2WPKH input 68 vB, taproot output 43 vB, P2WPKH output 31
vB, 10.5 vB overhead). Coin selection iterates over the buyer's UTXOs (largest
first, at most 20) until `Σ payment ≥ price + royalty + fee(vsize)`; if the
change would be below dust it is dropped and the remainder goes to the miner.
Tests assert the effective rate of the fully signed transaction is never below
the requested rate and within ~8 % above it. Rates come from mempool.space
`fees/recommended` (economy = `economyFee`, normal = `halfHourFee`, fast =
`fastestFee`, never below `minimumFee`).

### Dummy UTXOs

If the buyer has fewer than two confirmed UTXOs of 600–1 000 sats, `prepare`
returns a self-transfer that creates two 600-sat outputs. The buy is a second
round after that confirms. Both the dummies and the payment UTXOs are filtered
against the wallet's own inscription list and, when `UTXO_SAFETY_CHECK=true`,
against the indexer (`/r/utxo/{outpoint}` or Hiro `?output=`), so an inscribed
sat is never spent as payment.

## 4. Listing validity

A listing is valid while all of the following hold; they are checked on
`prepare`, on `create`, on `buy/prepare`, on `buy/submit`, and periodically by
the settlement watcher:

* `mempool.space /tx/{txid}/outspend/{vout}` reports the outpoint unspent;
* the indexer (`/r/inscription/{id}` or Hiro) reports the inscription at that
  outpoint, held by the seller's address;
* `expires_at` (≤ 30 days from creation) has not passed.

State machine (`src/settlement-watcher.js`):

```
active  ─ outpoint spent by tx paying seller price ─▶ sold
active  ─ outpoint spent by anything else ─────────▶ invalid
active  ─ indexer: moved / other owner / gone ─────▶ invalid
active  ─ expires_at passed ───────────────────────▶ expired
active  ─ seller signs "cancel" challenge ─────────▶ cancelled
active  ─ server broadcasts a buy ─────────────────▶ pending
pending ─ spend visible ───────────────────────────▶ sold / invalid
pending ─ nothing seen for PENDING_TIMEOUT_MS ─────▶ active
```

## 5. Threat model

| Threat | Mitigation |
|---|---|
| Inscription routed to the wrong output | FIFO assertion in the builder and again at submit; test reproduces the old failure |
| Seller signature forged / for a different price | Schnorr (or ECDSA) verification against the reconstructed sighash on create and against the real buy tx |
| Listing created for someone else's inscription | Indexer ownership check + BIP-322 challenge bound to action/inscription/price/address, single use, 10-minute TTL |
| Cancel by a third party | Same BIP-322 challenge, action `cancel`, seller address must match the listing |
| Fake "sold" marking to hide a listing | No sold endpoint; the watcher derives status from chain facts |
| Buyer wallet signs a transaction it did not see | No dummy-input trick; the buyer signs the real transaction |
| Malicious client alters the PSBT between prepare and submit | Server compares the unsigned transaction byte-for-byte with the session it issued, merges only signature material |
| Spending an inscribed UTXO as payment | Wallet exclusion list + indexer `/r/utxo` check; inscription outpoint and dummies excluded explicitly |
| Underpaying fees / overpaying by mistake | Real vsize estimate per script type, presets from mempool.space, change dropped only when dust |
| Stale listing (seller moved the inscription) | Outspend + indexer check before every build, and the watcher marks it `invalid` |
| Replay of a buy session | Sessions are single-use and expire after `BUY_SESSION_TTL_SEC` |
| XSS via inscription metadata | No `innerHTML` with data; CSP `script-src 'self'` |
| Serving the database / server code | Static root is `public/` only |

Not mitigated (out of scope for this phase): a front-running buyer who sees a
listing and completes it with their own payment (by design: any buyer may
complete a listing); RBF/replacement of a pending purchase by the buyer (the
watcher simply re-opens the listing after the timeout); rate limiting of the API.

## 6. What still needs signet verification

Everything below is implemented and unit-tested against `@scure/btc-signer`'s
own signer, but has **not** been exercised with a real UniSat extension or a
real chain. `BUYS_ENABLED` must stay `false` until each item is ticked off on
signet (`BITCOIN_NETWORK=signet`, an ord/Hiro indexer that covers signet, and a
funded UniSat signet account):

1. UniSat accepts the 3-input template with two zero-txid placeholder inputs
   and signs input #2 with `sighashTypes: [0x83]`, `autoFinalized: false`,
   returning `tapKeySig` (65 bytes). If UniSat rejects the placeholders, the
   fallback is to use the seller's own inscription outpoint duplicated in the
   placeholder slots (also uncommitted under ANYONECANPAY).
2. UniSat's `getPublicKey()` for a taproot account yields the key that
   `p2tr(xonly)` maps to the connected address (the server's
   `paymentForOwner` check).
3. UniSat signs the buyer's inputs of the assembled purchase with
   `autoFinalized: true` and returns `finalScriptWitness` for each; the merged
   transaction extracts and is accepted by `mempool.space/signet/api/tx`.
4. The confirmed purchase shows the inscription at output #1 of the buy tx in
   the indexer (`/r/inscription/{id}` → `satpoint = <buytxid>:1:<offset>`).
5. The dummy-creation round trip (no small UTXOs → split tx → buy).
6. A P2WPKH (`bc1q`) seller listing and purchase.
7. The settlement watcher flips the listing to `sold` from the live outspend
   endpoint, and to `invalid` when the seller moves the inscription elsewhere.
8. Royalty output with `ROYALTY_BPS > 0` and a real `TREASURY_ADDRESS`.

Owner decisions required before enabling: the treasury address, the royalty
basis points, and which indexer (ordinals.com recursive endpoints vs. Hiro) to
rely on in production.
