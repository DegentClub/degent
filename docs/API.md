# HTTP API

All endpoints are under `/api`. Request and response bodies are JSON. Mutations
are `POST` only. Errors are `{ "error": string, "code"?: string, "issues"?: [...] }`.

Validation rules (zod, `src/validation.js`):

* `inscriptionId` — `^[0-9a-f]{64}i\d{1,6}$`
* addresses — bech32/bech32m for the configured network; only key-path taproot
  (`bc1p`) and native segwit (`bc1q`) accounts are accepted for signing
* `publicKey` — 33-byte compressed hex
* `priceSats` — integer in `[PRICE_MIN_SATS, PRICE_MAX_SATS]` (default 1 000 sats … 100 BTC)
* `expiresInDays` — integer `1…LISTING_MAX_DAYS` (default and max 30)
* unknown fields are rejected

## Read

### `GET /api/health`
`{ ok, ts, buysEnabled, network }`

### `GET /api/config`
Public configuration: `{ buysEnabled, network, mempoolWeb, royaltyBps, priceMinSats, priceMaxSats, listingMaxDays, dummyValueSats }`

### `GET /api/collection`
The collection manifest (array of `{ name, inscription_id, inscription_number, ... }`). Cached 1 h.

### `GET /api/listings`
Active listings. Each listing:

```json
{
  "inscriptionId": "…i0", "inscriptionNumber": 93832030, "name": "Degent #1",
  "contentType": "image/webp", "outputValue": 10000, "location": "txid:vout",
  "satOffset": 0, "priceSats": 50000, "sellerAddress": "bc1p…",
  "status": "active", "statusReason": null, "settlementTxid": null,
  "createdAt": "…", "expiresAt": "…"
}
```
The seller-signed PSBT is never returned.

### `GET /api/listings/count` → `{ count }`

### `GET /api/listings/:id`
Any listing by inscription id, including non-active ones (status `active | pending | sold | invalid | expired | cancelled`). `403` if not a Degent, `404` if never listed.

### `GET /api/fees`
`{ economy, normal, fast, minimum }` in sat/vB from mempool.space.

## Listing

### `POST /api/challenge`
Body: `{ action: "list" | "cancel", address, inscriptionId, priceSats? }`
(`priceSats` required for `list`).
Returns `{ nonce, message, expiresAt }`. Sign `message` with
`window.unisat.signMessage(message, 'bip322-simple')`. Single use, 10 minutes.

### `POST /api/listings/prepare`
Body: `{ inscriptionId, sellerAddress, sellerPublicKey, priceSats }`

Checks the indexer (owner + location) and mempool (unspent), then returns the
template PSBT:

```json
{ "psbtHex": "…", "psbtBase64": "…", "signIndex": 2, "sighashType": 131,
  "inscription": { "outpoint": "txid:vout", "offset": 0, "value": 10000, "contentType": "…", "number": 1 } }
```
Sign with `signPsbt(psbtHex, { autoFinalized: false, toSignInputs: [{ index: 2, address, sighashTypes: [0x83] }] })`.

Errors: `403` not the owner / not a Degent, `404` not indexed, `409` already listed or outpoint spent (`code: SPENT | MOVED | WRONG_OWNER | UNKNOWN_OUTPOINT`).

### `POST /api/listings`
Body: `{ inscriptionId, sellerAddress, sellerPublicKey, priceSats, expiresInDays?, signedPsbt, nonce, signature }`

Verifies the BIP-322 signature for the `list` challenge, re-derives the
template, checks the signed PSBT matches it, verifies the seller's signature,
re-checks validity, stores. `201 { ok, listing }`.
Errors: `401` bad/used/expired challenge, `400` PSBT or signature problems, `409` conflicts.

### `POST /api/listings/:id/cancel`
Body: `{ sellerAddress, nonce, signature }` for a `cancel` challenge. `200 { ok }`.
Errors: `401`, `403` not the seller, `404` no open listing.

There is **no** endpoint to mark a listing sold. See the settlement watcher.

## Buying (`503 BUYS_PAUSED` unless `BUYS_ENABLED=true`)

### `POST /api/buy/prepare`
Body: `{ inscriptionId, buyerAddress, buyerPublicKey, feeTier?: "economy"|"normal"|"fast", excludeOutpoints?: ["txid:vout", …] }`

`excludeOutpoints` should be every outpoint the wallet reports as holding an
inscription. The server additionally asks the indexer about each candidate
UTXO when `UTXO_SAFETY_CHECK=true`.

Response when the buyer already has two small UTXOs:

```json
{ "needsDummies": false, "sessionId": "…", "psbtHex": "…",
  "toSignInputs": [{ "index": 0, "address": "bc1p…" }, { "index": 1, … }, { "index": 3, … }],
  "summary": { "priceSats": "50000", "royaltySats": "1000", "feeSats": "8940", "feeRate": 20,
               "estimatedVsize": 447, "changeSats": "…", "postageSats": "10000", "dummyMergeSats": "1300",
               "totalBuyerCost": "59940", "paymentInputs": ["txid:vout"], "dummyInputs": ["…", "…"],
               "outputs": [{ "index": 0, "value": "1300" }, …] },
  "ordinalDestination": { "outputIndex": 1, "offsetInOutput": "0" },
  "note": "…" }
```

Response when the buyer first needs dummy UTXOs: `{ "needsDummies": true, sessionId, psbtHex, toSignInputs, summary, note }` — sign and submit it, wait for confirmation, then call `prepare` again.

Sign with `signPsbt(psbtHex, { autoFinalized: true, toSignInputs })`.

Errors: `409` listing not active / expired / invalid (`code`), `400 INSUFFICIENT_FUNDS`, `400` own listing.

### `POST /api/buy/submit`
Body: `{ sessionId, signedPsbt }`

Verifies the signed PSBT is the session's transaction with only signatures
added, finalizes, re-asserts the ordinal destination, re-checks the listing,
broadcasts. `200 { ok, txid, kind: "buy" | "dummies", vsize, feeSats, explorer }`.
For `kind: "buy"` the listing moves to `pending` until the watcher sees the spend.

Errors: `404` unknown/closed session, `410` expired session, `400` tampered or unsigned PSBT, `502` broadcast rejected.
