# @bsh/degent-market

Non-custodial construction of Degent marketplace transactions: a seller **lists** by signing one
input, a buyer **purchases** by building the rest of the transaction around that signature. No
party ever holds another party's key, and nothing here suppresses wallet warnings.

Pure TypeScript on `@scure/btc-signer` 2.x and `@noble/curves` 2.x; runs in the browser and Node.
Design context: [ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md) §5.

## The audited bug, and the fix

Ordinal theory assigns sats **first-in, first-out**: the input sats are concatenated in input order
and handed to the outputs in output order; the fee is the tail. An inscription lives on one sat.

The audited marketplace built purchases as

```
inputs  [0] seller inscription   [1] buyer payment
outputs [0] seller payment       [1] buyer "receives"   [2] change
```

The inscription's sat is the very first input sat, so it becomes the first sat of **output 0: the
seller's payment**. The seller is paid *and* keeps the inscription. The buyer's output 1 receives
only plain sats.

This package builds the standard padded layout instead:

```
inputs  [0] buyer padding A      outputs [0] padding merge = A + B   (buyer)
        [1] buyer padding B              [1] buyer receives = inscription UTXO value
        [2] seller inscription (0x83)    [2] seller payment = price   <- the seller signed this
        [3..] buyer payment(s)           [3] buyer change            (optional)
                                         [4..] new padding outputs   (optional, for the next buy)
```

Output 0 consumes exactly the padding sats, so the inscription's sat (at offset `k` in its UTXO)
is sat `k` of output 1, the buyer's. The fee comes off the tail (the buyer's payment coins), never
off the inscription.

Both claims are **proved in tests** with `simulateOrdinalTransfer`, an independent FIFO simulator:
a matrix of prices, postages, padding sizes, fees and inscription offsets lands in the buyer
output for the padded layout; the legacy layout lands in the seller output for every case, which
reproduces the bug. `buildPurchase` also runs the simulator on every transaction it builds and
throws if the sat would land anywhere but output 1.

## Why SIGHASH_SINGLE | ANYONECANPAY for the seller

The seller signs input 2 with `0x83`. BIP341 then commits to: nVersion, nLockTime, the seller's
input (outpoint, amount, scriptPubKey, nSequence) and **the output at the same index** (output 2:
seller address and price). Nothing else. So:

- The buyer can add padding, payment, the receive output and change without the seller's help.
- Nobody can lower the price or redirect the payment: any change to output 2 breaks the signature
  (tested by mutating the final transaction).
- The seller's signature does **not** protect the buyer (output 1 is not covered). That is why the
  buyer builds the layout and this library proves placement, instead of trusting a transaction the
  seller or a marketplace server hands over. Buyers: only sign purchases built by code you trust,
  and read your wallet's warnings (it will point at input 2, which you do not own and which uses a
  non-default sighash; that is expected, and it is the one input you should double-check).
- Two sales of the same listing cannot both confirm: they spend the same inscription outpoint.

## API

```ts
import { buildSellerListing, verifyListing, buildPurchase, finalizePurchase, simulateOrdinalTransfer } from '@bsh/degent-market';

// Seller (their wallet holds the key; only the 65-byte signature leaves)
const listing = buildSellerListing({ network, inscription: { txid, vout, value, script, inscriptionOffset: 0 },
  sellerPrivkey, sellerReceiveAddress, priceSats: 50_000n });
verifyListing(listing); // { ok: true }  (anyone can check it)

// Buyer
const p = buildPurchase({ network, listing, feeRate: 5, newPaddingOutputs: 2,
  buyer: { padding: [padA, padB], payments: [coin1, coin2], receiveAddress: ordinalsAddr, changeAddress } });
p.inscriptionLandsIn; // { kind: 'output', index: 1, offset: 0n }
// wallet.signPsbt(p.psbtBase64, { inputsToSign: p.inputsToSign })
const { hex, txid, fee, vsize } = finalizePurchase(signedPsbt, listing); // re-checks the seller's signature

simulateOrdinalTransfer(inputs, outputs, fee); // where every inscribed sat goes
```

- Seller UTXO: P2TR key path (an ordinals address). Buyer coins: P2TR or P2WPKH.
- Padding inputs: exactly two, each at least 330 sats, inscription-free. `newPaddingOutputs`
  creates fresh 600-sat padding for the buyer's next purchase.
- Fees: `estimatePurchaseWeight` is exact for P2TR buyer inputs (Schnorr is fixed-size; tests assert
  equality with the signed transaction) and an upper bound for P2WPKH (DER may be 1 byte shorter;
  tests assert the bound). Sub-dust change goes to the fee rather than creating dust.

## Tests

`pnpm --filter @bsh/degent-market test` / `typecheck`.

| File | Covers |
|---|---|
| `test/ordinals.test.ts` | Simulator semantics; the padded-layout matrix (price x postage x padding x fee x offset) lands in output 1; off-by-one padding drags the sat into output 0; the legacy layout lands in the seller output for every case |
| `test/purchase.test.ts` | Real keys and real signatures: listing verify/tamper; purchases for taproot and segwit buyers; the seller's 0x83 Schnorr signature verified over the FINAL tx digest; every buyer signature verified; fee == inputs - outputs, fee rate >= target, weight exact (P2TR) or bounded (P2WPKH); FIFO placement on the final tx; what 0x83 does and does not cover; refusals (network, tampering, padding, funds); `finalizePurchase` refusing a swapped signature |

Not here (yet): an API/UI for listings, order-book storage, and PSBT export formats for specific
wallets. This package is the transaction core those will use.
