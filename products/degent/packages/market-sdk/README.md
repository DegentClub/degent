# @bsh/degent-market-sdk

Shared vocabulary of the degent.club marketplace: listing/buy domain types, the settlement layout constants, the
price / royalty / fee maths, and a typed client for `contracts/openapi/degent-market.yaml`. Used by
`@bsh/degent-market` (the service) and, later, by the web app. Membership vocabulary (`MembershipVia`,
`Network`) and `ApiError` come from `@bsh/degent-mint-sdk`, so both services describe Degents the same way.

| Export | Purpose |
|---|---|
| `LISTING_STATUSES`, `LISTING_TRANSITIONS`, `canTransition` | `active → pending → sold`, plus `invalid` / `expired` / `cancelled` (terminal) |
| `Listing`, `BuyPrepareResponse`, `BuySummary`, `TxInputView`, `TxOutputView`, … | Wire types; `BuySummary.inputs/outputs` is the whole transaction the buyer signs |
| `ListingStatusEvent` | Payload of `degent.market.listing.{status}` (`contracts/asyncapi/degent-market.yaml`) |
| `SETTLEMENT_LAYOUT`, `INSCRIPTION_INPUT_INDEX` (2), `PRICE_OUTPUT_INDEX` (2), `INSCRIPTION_OUTPUT_INDEX` (1), `DUMMY_COUNT` (2), `MIN_DUMMY_VALUE` (600) | The padding-input layout (ADR-0008) |
| `royaltyFor(price, bps)` | `floor(price × bps / 10 000)`, bps an integer in 0..5000; the buyer pays it on top of the price |
| `buyerCost(price, royalty, fee)` | What the buyer pays in total |
| `estimateVsize(inTypes, outTypes)`, `feeForVsize(vsize, rate)` | Worst-case vsize per script type; exact-decimal `ceil(vsize × rate)` |
| `presetsFromMempool(rec)` | mempool.space `fees/recommended` → economy / normal / fast (≥ minimum, ≥ 1) |
| `dustFor(type)`, `satsToBtc(sats)`, `priceInWindow(price, cfg)` | Helpers |
| `createMarketClient({ baseUrl, fetch? })` | Typed client; non-2xx → `ApiError { status, code, details }` |

The FIFO (sat assignment) maths is **not** here: it is `@bsh/inscription`'s `assignSats` /
`inscriptionDestination` / `assertNoInscriptionBurn`, the single implementation the service asserts with.

```bash
pnpm --filter @bsh/degent-market-sdk test
pnpm --filter @bsh/degent-market-sdk typecheck
```
