# @bsh/degent-market

The degent.club first-party marketplace: non-custodial, peer-to-peer trading of Degents settled with PSBTs.
Sellers sign "my Degent for this price" once (`SIGHASH_SINGLE|ANYONECANPAY` on input 2); a buyer later completes
it. The service builds, verifies and broadcasts transactions; it never holds a key.

**Buys ship disabled** (`BUYS_ENABLED=false`, 503 `buys_paused`) until the signet checklist in
[docs/SETTLEMENT.md §7](docs/SETTLEMENT.md) is done and an external review signs off
([ADR-0008](../../../../docs/adr/0008-first-party-marketplace-settlement.md)). Listing, viewing and cancelling work.

- Contracts: [`contracts/openapi/degent-market.yaml`](../../../../contracts/openapi/degent-market.yaml),
  [`contracts/asyncapi/degent-market.yaml`](../../../../contracts/asyncapi/degent-market.yaml) (`degent.market.listing.{status}`)
- Types, layout constants, royalty/fee maths, client: [`@bsh/degent-market-sdk`](../../packages/market-sdk/README.md)
- Design, threat model, signet checklist: [docs/SETTLEMENT.md](docs/SETTLEMENT.md)

## Layout (ports and adapters)

| Path | What |
|---|---|
| `src/domain/settlement/` | The engine, pure: seller template + signature extraction, buyer assembly + coin selection, padding round, signature verification, signed-PSBT assembly, and `fifo.ts`, the guard that asks `@bsh/inscription` where the inscription lands |
| `src/domain/listing.ts` | Listing / buy-session records, public projection, the watcher's pure `nextState` |
| `src/domain/validation.ts` | zod request schemas (strict) |
| `src/application/market-service.ts` | Use cases: list (prepare → create), cancel, buy (prepare → submit), validity checks |
| `src/application/auth.ts` | SIWB challenges (`@bsh/identity`) bound to `list:<id>:<price>` / `cancel:<id>`; BIP-322 verification and single-use nonces are the platform's |
| `src/application/lifecycle.ts` | Transitions: persist, publish `degent.market.listing.{status}`, wipe the seller signature on close |
| `src/application/settlement-watcher.ts` | Marks listings `sold` / `invalid` / `expired` / re-opened from chain + ord facts |
| `src/ports/` | `MarketChain` (esplora), `OrdIndexer` (ord recursive), `CollectionMembership`, `ListingStore` / `BuySessionStore`, `EventBus`, `Clock` |
| `src/adapters/` | esplora chain, ord indexer, memberships (memory, roster + `/r/parents`, mint Register via `@bsh/degent-mint-sdk`), memory + node:sqlite stores (+ SIWB `NonceStore`), memory event bus |
| `src/app.ts`, `src/config.ts`, `src/wiring.ts`, `src/main.ts` | Hono HTTP API (CORS allowlist, rate limit, kill-switch middleware), env config, composition root |

**Collection membership** follows the mint's idea (ADR-0007): a Degent is a roster (Gallery) inscription or a
child of the club parent. Production asks the mint's public Register (`GET /v1/register/verify/{id}`) through the
typed client in `@bsh/degent-mint-sdk`; no mint service code is imported.

## Run and test

```bash
pnpm --filter @bsh/degent-market dev         # regtest, in-memory adapters, buys paused, port 8788
pnpm --filter @bsh/degent-market test        # vitest: engine, FIFO guard, auth, watcher, API e2e, contract
pnpm --filter @bsh/degent-market typecheck
```

| Test file | Covers |
|---|---|
| `settlement-fifo` | FIFO via `@bsh/inscription`: legacy unsafe layout → seller (regression fixture), padding layout → buyer, offsets, burn, oversized merge, wrong script/postage, why `checkInscriptionCoverage` is not enough |
| `settlement-seller` | Template layout, untweaked internal key, 0x83 extraction, wrong sighash, template mismatch, P2WPKH/ECDSA, foreign key |
| `settlement-buyer` | Purchase layout, property test vs independent FIFO, fee tolerance vs signed vsize, multi-UTXO selection, dust change, insufficient funds, padding rules, signature/price binding, royalty rules, padding round |
| `settlement-assemble` | Signed-PSBT merge, partial signatures, base64, tampering (royalty, seller, postage), missing signatures, raw-bytes guard |
| `auth` | BIP-322 fixtures from the `@bsh/identity` signer (P2TR, P2WPKH), SIWB binding, single use, expiry, mismatched claims don't burn the nonce, foreign domain |
| `watcher` | `nextState` transitions; ticks with a mocked chain/ord: sold, invalid (moved), healthy, expiry, outages, pending re-open |
| `api` | Hardening, the BUYS_ENABLED gate (HTTP and service), listing lifecycle, cancel, P2WPKH seller, buy flow to `sold`, padding round, inscribed-UTXO safety, tampering, sessions, outages |
| `e2e` | The SDK client end to end: paused → list → enable → buy → sold, the buyer's view equals the PSBT, FIFO re-derived from the broadcast bytes |
| `contract` | Routes, error codes, status enums, live responses and events vs OpenAPI / AsyncAPI |
| `validation`, `stores`, `adapters`, `config` | zod schemas; memory/sqlite parity (listings, sessions, nonces); HTTP adapters; env rules and `env.schema.json` |

## Environment

See [`env.schema.json`](env.schema.json). The ones that matter:

| Variable | Default | Purpose |
|---|---|---|
| `BUYS_ENABLED` | `false` | Kill switch for `/v1/buy/*` (503 `buys_paused`) and the Buy buttons |
| `ROYALTY_BPS` | `0` | Royalty on every sale (basis points, 0..5000), paid by the buyer on top of the price |
| `TREASURY_ADDRESS` | — | Receives the royalty; required when `ROYALTY_BPS > 0` |
| `MEMBERSHIP` / `MINT_API_URL` | `mint-register` | Who counts as a Degent |
| `DATABASE_PATH` | — | node:sqlite file (required off regtest) |
| `ESPLORA_URL`, `ORD_URL` | per network, `https://ordinals.com` | Chain and ord backends |
| `UTXO_SAFETY_CHECK` | `true` | Ask ord before spending any buyer UTXO |

## UI contract (for the web app, later pass)

`apps/web` is not touched by this slice. When the marketplace UI is built it must follow this contract (all data
from `@bsh/degent-market-sdk`'s client; never recompute layout, royalty or FIFO in the browser):

**Paused banner.** On load call `config()`. While `buysEnabled === false`: show a persistent banner ("Buying is
paused while the settlement engine is verified on signet and reviewed"), disable every Buy button, and treat
503 `buys_paused` from any buy call as the same state. Listing, browsing and cancelling stay available.

**Listing card** (grid from `listings()`, detail from `listing(id)`): Degent image (ord `/content/{inscriptionId}`),
`Degent #n` (`degent.n`, or "child" when `n` is null), price in BTC (`satsToBtc(priceSats)`) and sats, royalty line
when `royaltySats > 0` ("+ {royaltySats} sats royalty"), seller address (shortened, full on hover), listed/expires
dates, status chip for non-active statuses (`pending`: "purchase in flight"; `sold` with an explorer link to
`settlementTxid`; `invalid` with `statusReason`). Buy button only when `status === 'active'`, buys enabled and the
viewer is not the seller.

**List flow** (seller): connect a taproot or native segwit wallet (`@bsh/wallet-kit`) → enter price (validate the
window from `config()`) → `prepareListing` → show "your wallet will show this Degent being spent: that is the
listing; you receive exactly {price} at output 2" → wallet `signPsbt(psbtHex, { autoFinalized: false,
toSignInputs })` (index 2, sighash 0x83) → `challenge({ action: 'list', … })` → wallet `signMessage(message,
'bip322-simple')` → `createListing`. Map `not_a_degent`, `not_owner`, `already_listed`, `listing_invalid`
(`details.reason`), `bad_psbt`, `bad_seller_signature`, `auth_failed` to plain messages. Cancel: `challenge({
action: 'cancel' })` → sign → `cancelListing`; explain that moving the Degent is the only on-chain cancel.

**Buy flow** (buyer, only when enabled): choose a fee tier from `fees()` → `buyPrepare({ …, excludeOutpoints:
<every outpoint the wallet reports as inscribed> })`. If `kind === 'dummies'`: explain the padding step, show
`summary` (two 600-sat outputs + change, fee), sign, `buySubmit`, wait for one confirmation, then prepare again.
If `kind === 'buy'`: **show the real transaction before signing**, built from `summary.inputs` and
`summary.outputs` (every index, value, address, owner, role), highlighting output #1 "your Degent arrives here"
(`inscriptionDestination`), output #2 "seller receives", the royalty output, change, fee rate and
`totalBuyerCostSats`; warn that the wallet will show an inscription input (#2) being spent and that this is
expected. Then `signPsbt(psbtHex, { autoFinalized: true, toSignInputs })` → `buySubmit` → show the txid and
`explorerUrl`, and poll `listing(id)` until `sold`. Map `insufficient_funds`, `listing_not_active`,
`listing_expired`, `own_listing`, `session_expired` (prepare again), `broadcast_rejected`, `inscription_misrouted`
(never expected; report it) to plain messages.
