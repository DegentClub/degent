# ADR-0002: degent.club automated mint: non-custodial, parent-linked, block-sized

- **Status:** Accepted (implementation in progress in this repo)
- **Date:** 2026-09-23
- **Components:** `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/degent-mint-sdk`, `@bsh/degent-mint`, `@bsh/degent-web`
- **Supersedes:** the mint flow in `antron3000/degen-minter-3` (UniSat-only, payment to a Skrybit-held address, no status tracking, no provenance)

## Context

The degent.club collection (the Decentralized Gentlemen Club) is 4,112 inscriptions and ~1.51 GB according to the
hand-maintained manifest `Degent-Marketplace/collection.json`. Individual items range from 205 KB to 3.96 MB.
The audit found:

- Membership is a JSON file edited by hand; nothing on-chain proves an item belongs to the collection.
- The live minter (`degen-minter-3`) only accepts 200–400 KB files, supports one wallet (UniSat), sends the
  user to a payment address held by the Skrybit API, and hides the inscription id, so the user never sees
  their mint land.
- Existing inscription services (legacy Skrybit backend, skrybit-suite) hold the reveal key server-side,
  sometimes in plaintext.

The product goal: **anyone can mint a Degent, including a block-sized one (~4 MB), from the website with no
human in the loop, and what they see before paying is exactly what lands on chain.**

## Decision

### 1. Two lanes, sized by Bitcoin's real limits

| Tier | Content size | Reveal tx weight | Relay path | Throughput |
|---|---|---|---|---|
| **Standard Degent** | 200 KB – ~390 KB | ≤ 400,000 WU (`MAX_STANDARD_TX_WEIGHT`) | Normal P2P mempool | Many per block |
| **Block Degent** | > 390 KB – ~3.9 MB | ≤ 3,990,000 WU (consensus max 4,000,000 WU minus headroom for header + coinbase) | Non-standard: Libre Relay peers (fleet `libre-mainnet`, ADR-076 in `infra`) and/or MARA Slipstream | **One per block** by construction |

Witness bytes weigh 1 WU each, so a ~3.96 MB envelope fits in one block, which is how the collection's largest
items were made. A Block Degent at 2 sat/vB costs about 1,000,000 vB × 2 = 0.02 BTC in fees; the front end
must say so before the user commits.

### 2. Commit / reveal with no custodial key

1. The **browser** generates an ephemeral x-only key `K_e` (never sent to the server).
2. The inscription tapscript is
   `<K_e> OP_CHECKSIG OP_FALSE OP_IF "ord" 0x01 <content-type> 0x03 <parent-id> 0x00 <body 520-byte chunks…> OP_ENDIF`.
   The commit output is P2TR with the NUMS internal key and this single leaf.
3. The browser builds the **funding PSBT** (user's segwit/taproot UTXOs → commit output + change) and computes
   its txid from the unsigned transaction (segwit txids exclude witnesses).
4. The browser builds the **reveal** and signs the commit input with `K_e` using
   **`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (0x83)**:
   - inputs: `[0] parent inscription UTXO (added later by the service)`, `[1] commit output`
   - outputs: `[0] parent return (same value), [1] child → user's ordinals address (postage)`
   - the signature commits only to input 1's outpoint/amount/script and output 1, **not** to the parent input.
5. The browser uploads the half-signed reveal to the service **before** the user signs the funding PSBT, and
   keeps a local recovery copy. `K_e` is then discarded.
6. The user signs and broadcasts the funding transaction with any wallet (Wallet Kit).
7. When the commit is seen, the service leases the current parent UTXO, adds input 0 / output 0, has the
   **policy signer** sign input 0 (see §3), and broadcasts through the tier's lane.

Properties:

- The service never holds a key that can move user funds. It holds only a half-signed transaction whose child
  output is fixed to the user's address.
- **Self-rescue:** because of 0x83, the same signature is valid in a one-input/one-output transaction
  `[commit] → [child]`. If the service disappears, the user (or anyone) can broadcast the reveal without the
  parent. The inscription still lands, only without on-chain parent provenance. The front end offers this as a
  one-click "rescue" after a timeout.
- **No parent contention for abandoned orders:** the parent outpoint is not signed by the user, so orders that
  are never funded do not block the parent chain.
- Fee = commit value − postage, fixed at quote time. The service cannot lower the user's output.

### 3. Parent co-signing by a policy signer

The collection parent key lives behind a `PolicySigner` port (KMS/HSM in production, an in-memory key in tests).
It signs input 0 **only if** the transaction:

- spends exactly one parent UTXO (input 0) and one commit output (input 1);
- returns the parent to the collection address with value ≥ its input value (output 0);
- pays the child to the recipient recorded on the order with postage ≥ 330 sats (output 1);
- has no other outputs;
- matches the fee rate band of the order's lane.

Anything else is refused and logged.

### 4. What you see is what you get

The same `@bsh/inscription` code runs in the browser and in the service:

- **Content:** the preview is rendered from the exact bytes that go in the envelope; the SHA-256 is shown.
  After confirmation the service fetches `/content/<inscription id>` from ord and marks the order `verified`
  only if the hash matches.
- **Size and fee:** `estimateRevealWeight()` is exact, and tests assert it equals the weight of the real signed
  transaction across content sizes from 1 byte to 3.9 MB.
- **Commit address:** the service recomputes the commit address from `(K_e pub, content, parent, network)` and
  rejects the order if it differs from the browser's.
- **Queue and ETA:** Block Degents are one per block, so the UI shows the queue position and an ETA (position ×
  ~10 min), not a promise.

### 5. Automated validation, no manual collection list

`@bsh/degent-mint-sdk` holds the rules shared by the front end and the service: allowed MIME types, size
bounds per tier, dimension bounds, and SHA-256. An `ArtReview` port runs an automated guideline check (a
vision-model adapter in production, deterministic rules in tests) **before** payment, so nobody pays for art
that will be refused. Collection membership is the parent link, which block.space and any ord indexer can
verify.

### 6. Order state machine

```
awaiting_content → reviewing → approved ─┐
                        └→ rejected      │
approved → awaiting_payment (reveal half-signed and stored)
awaiting_payment → paid (commit seen) → queued (lane) → revealing → revealed (in mempool)
revealed → confirmed → verified (content hash matches on ord) → delivered
any pre-paid state → expired ; paid/queued/revealing → rescue_available (after timeout)
```

Every transition is persisted with a timestamp and emitted as a `degent.mint.*` event
(`contracts/asyncapi/degent-mint.yaml`).

## Consequences

- Minting works with any wallet that can sign a standard PSBT; users never sign the reveal.
- Block Degents are serialized one per block; the product must present that honestly (queue + ETA).
- Payment addresses must be segwit/taproot so the funding txid is known before signing; legacy addresses get
  a clear message.
- The parent key is company custody, protected by the policy signer. Loss of the parent key stops provenance
  for new mints but never strands user funds (self-rescue).
- Requires a Libre Relay or Slipstream broadcast path in production for Block Degents.
