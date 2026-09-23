# Degent Marketplace

Peer-to-peer marketplace for the **Decentralized Gentlemen Club** Bitcoin Ordinals
collection (4,112 inscriptions). Sellers sign a partial transaction (PSBT) that
commits to "my inscription for this price"; a buyer later completes it. Nothing
is custodied: the server only builds, verifies and broadcasts transactions.

> **Buying is currently paused** (`BUYS_ENABLED=false`). See
> [Why buys were paused](#why-buys-were-paused). Listings can still be created,
> viewed and cancelled.

## Layout

```
public/            static site (index.html, styles.css, app.js, collection.json)
src/
  index.js         entry point
  app.js           Express factory (helmet/CSP, CORS, routes, static)
  config.js        env → config
  db.js            SQLite schema (file lives OUTSIDE public/)
  validation.js    zod request schemas
  auth.js          BIP-322 challenge/response for list + cancel
  indexer.js       mempool.space + ord/Hiro clients, listing validity check
  settlement-watcher.js   marks listings sold/invalid/expired from chain facts
  psbt/            settlement engine (@scure/btc-signer)
    seller.js      listing template, seller signs input #2 SINGLE|ANYONECANPAY
    buyer.js       purchase assembly, coin selection, FIFO assertion
    verify.js      Schnorr/ECDSA verification, buyer PSBT assembly
    ordinals.js    computeOrdinalDestination (FIFO)
    fees.js        vsize estimation, fee presets, royalty
  routes/          listings.js, buy.js
tests/             vitest suite (npm test)
docs/              SETTLEMENT.md (transaction design), API.md
legacy/            psbt-unsafe.js — the old engine, kept as an audit record
```

## How a listing settles

1. Seller opens *List for Sale* and enters a price. The client sends
   `POST /api/listings/prepare`; the server checks with the inscription indexer
   that the seller's address really holds the inscription at an unspent
   outpoint, then returns a 3-input / 3-output **template PSBT** with the
   inscription at **input #2** and `price → seller` at **output #2**.
2. UniSat signs input #2 with `SIGHASH_SINGLE | ANYONECANPAY` (0x83). The
   wallet shows the inscription being spent — that is the listing.
3. The client requests a challenge (`POST /api/challenge`, action `list`) and
   signs it with `signMessage(msg, 'bip322-simple')`.
4. `POST /api/listings` verifies the BIP-322 signature, re-derives the template
   byte-for-byte, extracts and **cryptographically verifies** the seller's
   Schnorr signature, and stores the listing (max 30 days).

## How a buy settles

1. `POST /api/buy/prepare`: the server re-validates the listing, fetches the
   buyer's confirmed UTXOs from mempool.space, drops anything the wallet or the
   indexer says carries an inscription, picks two small "dummy" UTXOs
   (600–1000 sats) and enough payment UTXOs, and assembles:

   | # | input                    | # | output                        |
   |---|--------------------------|---|-------------------------------|
   | 0 | buyer dummy #1           | 0 | dummy merge → buyer           |
   | 1 | buyer dummy #2           | 1 | inscription postage → buyer   |
   | 2 | **inscription** (seller) | 2 | **price → seller**            |
   | 3+| buyer payment UTXO(s)    | 3 | royalty → treasury (if bps>0) |
   |   |                          | 4 | change → buyer                |

   The seller's signature is verified against this exact transaction, and
   `computeOrdinalDestination` asserts the inscribed sat lands in output #1.
   Fees use real vsize × a mempool.space preset (economy / normal / fast).
   If the buyer has no dummy UTXOs, the first round returns a small
   self-transfer that creates them.
2. UniSat signs the buyer's inputs (`autoFinalized: true`). The wallet will
   show an inscription input being spent; that is correct and expected.
3. `POST /api/buy/submit`: the server checks the signed PSBT matches the one it
   issued, finalizes, re-runs the FIFO assertion, re-checks the listing, and
   broadcasts through mempool.space. The listing becomes `pending`.
4. The **settlement watcher** polls `/tx/{txid}/outspend/{vout}`; once the
   listed outpoint is spent by a transaction paying the seller the listed
   price the listing is `sold`. Any other spend, or the indexer showing the
   inscription elsewhere, makes it `invalid`. There is no client "sold" call.

Full design, sighash rationale and threat model: [docs/SETTLEMENT.md](docs/SETTLEMENT.md).
Endpoints: [docs/API.md](docs/API.md).

## Run

```bash
npm ci
cp .env.example .env         # edit as needed; defaults are safe (buys paused)
npm start                    # http://localhost:3000
```

Node ≥ 20.19. The SQLite file defaults to `./data/market.db`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BUYS_ENABLED` | `false` | Kill switch for `/api/buy/*` and the Buy button |
| `CORS_ORIGIN` | *(empty)* | Exact browser origin allowed to call the API; empty = same-origin only |
| `BITCOIN_NETWORK` | `mainnet` | `mainnet` / `testnet` (testnet4) / `signet` |
| `MEMPOOL_API` | per network | Esplora base, e.g. `https://mempool.space/signet/api` |
| `INDEXER` | `ord` | `ord` (recursive `/r/…` endpoints) or `hiro` |
| `ORD_API` / `HIRO_API` | `https://ordinals.com` / `https://api.hiro.so` | Indexer base URLs |
| `UTXO_SAFETY_CHECK` | `true` | Ask the indexer whether each payment UTXO carries an inscription |
| `DB_PATH` | `./data/market.db` | SQLite location (never under `public/`) |
| `ROYALTY_BPS` | `0` | Royalty on every sale in basis points (100 = 1%) |
| `TREASURY_ADDRESS` | *(empty)* | Receives the royalty output; required when bps > 0 and buys enabled |
| `PRICE_MIN_SATS` / `PRICE_MAX_SATS` | `1000` / `10000000000` | Listing price window (1 000 sats – 100 BTC) |
| `LISTING_MAX_DAYS` | `30` | Maximum listing lifetime |
| `WATCHER_INTERVAL_MS` | `60000` | Settlement watcher poll interval |
| `PENDING_TIMEOUT_MS` | `21600000` | Re-open a `pending` listing if the buy tx never appears |
| `CHALLENGE_TTL_SEC` / `BUY_SESSION_TTL_SEC` | `600` | Lifetimes of sign-in challenges / prepared buys |

## Test

```bash
npm test
```

The suite covers the FIFO calculator (including a reproduction of the old
layout handing the inscription to the seller), the seller/buyer PSBT builders
(layout, sighash flags, fee tolerance, royalty math, tampering), zod
validation, BIP-322 verification with a fixture generated by `bip322-js`, the
settlement watcher state machine with mocked fetch, and the HTTP API end to
end with a mocked network. CI runs it on Node 20 and 22
(`.github/workflows/ci.yml`).

## Why buys were paused

An audit of the previous browser-side engine (`legacy/psbt-unsafe.js`) found
that the final transaction put the inscription at **input 0** and the seller's
payout at **output 0**. Under ordinal theory sats flow first-in-first-out, so
the inscribed sat went straight to the seller's payout output: the buyer paid
and received nothing but postage. Compounding this, the buyer signed a
transaction with a zeroed dummy input specifically so the wallet would not
warn about an inscription being spent, the taproot internal key was set to the
tweaked output key, and the seller's signature was never verified.

The engine has been rewritten server-side on `@scure/btc-signer` with an
explicit FIFO assertion, real signature verification and no wallet-warning
suppression. Until the new flow has been exercised end to end on **signet**
with real UniSat signing (see "What still needs signet verification" in
`docs/SETTLEMENT.md`), `BUYS_ENABLED` stays `false`.

## Security notes

* The server serves `public/` only; `market.db`, `src/` and `legacy/` are not
  reachable over HTTP. `helmet` sets a CSP with `script-src 'self'`.
* All mutations are `POST` with JSON bodies validated by zod.
* Listing create/cancel require a BIP-322 signature over a single-use
  server-issued challenge bound to the action, inscription, price and address.
* The browser never renders server data through `innerHTML`.
* The seller-signed PSBT is never returned by the API; only the server
  assembles purchases.
