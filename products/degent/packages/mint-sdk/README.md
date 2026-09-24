# @bsh/degent-mint-sdk

Rules, domain types and the typed HTTP client for the degent.club mint, shared by the front end
(`@bsh/degent-web`) and the service (`@bsh/degent-mint`) so that what the user sees is computed from the same
definitions the service enforces. Contract: [`contracts/openapi/degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml).
Design: [ADR-0002](../../../../docs/adr/0002-degent-mint-architecture.md), amended by
[ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md) (tiers, lanes, block budget, rescue inputs).

Pure TypeScript, no Node APIs: runs in the browser and in Node 22. Only dependency: `@noble/hashes`.
Transaction, weight and fee maths are **not** here; they live in `@bsh/inscription`.

## Rules (`rules.ts`)

Tiers are a product decision on **content bytes**; lanes are transport, decided by **reveal weight**
(ADR-0005 §3). Keep the two apart: a Standard Degent of 397-400 KB weighs more than 400,000 WU and
travels the block lane, and the quote's `lane` says so.

| `Tier` | Label (`TIER_LABELS`) | Content bytes | Usual lane | `sharesBlock` |
|---|---|---|---|---|
| `standard` | Standard Degent | 200,000-400,000 | standard | true |
| `large` | Large Degent | 400,001-3,499,999 | block | true |
| `fullblock` | Full Block Degent | 3,500,000-3,900,000 | block | false |

```ts
import { DEFAULT_CONFIG, tierForSize, laneForWeight, validateContentMeta, sha256Hex, formatSats, formatBtc, estimateTotal } from '@bsh/degent-mint-sdk';

tierForSize(250_000)?.tier;                    // 'standard'
tierForSize(1_000_000)?.tier;                  // 'large'
tierForSize(3_600_000)?.tier;                  // 'fullblock'
laneForWeight(403_285);                        // 'block'  (<= 400,000 WU standard, <= 3,990,000 WU block, else null)

const v = validateContentMeta({ contentType: 'image/webp', contentLength: 250_000, width: 1024, height: 1024, tier: 'standard' });
v.ok;        // true
v.checks;    // [{ id: 'content_type', passed, detail }, { id: 'size', ... }, { id: 'tier', ... }, { id: 'width', ... }, { id: 'height', ... }]
v.reasons;   // details of the failed checks, ready to show

sha256Hex(bytes);          // lowercase hex, identical in browser and Node
formatSats(2_000_546);     // '2,000,546 sats'
formatBtc(2_000_546);      // '0.02000546 BTC' (exact, bigint maths)
estimateTotal(quote, { vsize: 153, feeRate: 2 }); // { commitValueSats, serviceFeeSats, fundingFeeSats, totalSats, ... }
```

`DEFAULT_CONFIG`: types `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/gif`; dimensions
256-4096 px; postage 546 sats; minimum 1 sat/vB; quote TTL 900 s; rescue after 6 h; service fee 0 per tier
(`serviceFeeSats: { standard, large, fullblock }`).

## Block-lane packing (`queue.ts`)

The block lane has a per-block weight budget (`BLOCK_LANE_WEIGHT_BUDGET` = 3,990,000 WU, ADR-0005 §4).
`packBlockSlots(waiting, { inFlight })` packs orders into block slots greedily in queue order (no
overtaking); a `sharesBlock: false` item (Full Block Degent) always takes a slot alone. `blockSlotOf`
gives an order's 1-based slot (its queue position; ETA = slot x ~10 min) and `fitsInFlight` tells the
worker whether the next order can join the block already in flight. Three ~1.2 M WU Large Degents
share slot 1; a fourth opens slot 2.
The service serves its live values at `GET /v1/config`; prefer those at runtime.

## Image headers (`image.ts`)

`readImageInfo(bytes)` returns the real type (from magic bytes) and pixel dimensions for PNG, JPEG, WebP
(VP8/VP8L/VP8X), GIF and AVIF without decoding pixels. Bounds-checked; malformed input yields `null`.
The service's rules reviewer uses it on the uploaded bytes; the front end can use it for instant feedback.

## Client (`client.ts`)

```ts
import { createMintClient, ApiError } from '@bsh/degent-mint-sdk';

const mint = createMintClient({ baseUrl: 'https://mint.degent.club' }); // optional { fetch } for tests

const { order, orderToken } = await mint.createOrder({ tier, contentType, contentLength, contentSha256, recipientAddress, revealPubkey, feeRate });
// orderToken is returned ONCE. Store it with the local recovery bundle; the service keeps only its hash.
const approved = await mint.uploadContent(order.id, orderToken, bytes);        // binding quote + commitAddress
const paying = await mint.submitReveal(order.id, orderToken, { commitTxid, commitVout, halfSignedRevealPsbt, commitAddress });
const latest = await mint.getOrder(order.id);                                   // public, no token
const inputs = await mint.getRescue(order.id, orderToken);                      // RescueInputs, only when status === 'rescue_available'
// -> @bsh/inscription.buildResignedRescue({ revealPrivkey: K_e from the recovery bundle, ...inputs }) in the browser

try { /* ... */ } catch (e) {
  if (e instanceof ApiError) console.log(e.status, e.code, e.message, e.details);
}
```

Every endpoint is covered: `health`, `config`, `fees`, `queue`, `createOrder`, `uploadContent`,
`submitReveal`, `getOrder`, `getRescue`. Non-2xx responses and network failures raise `ApiError`
(`status` 0 and `code: 'network_error'` for the latter).

## Types (`types.ts`)

`Order`, `OrderStatus` (+ `ORDER_STATUSES`), `Quote` (`binding: false` on the indicative quote from
`POST /v1/orders`, `true` with `commitAddress` after upload), `CreateOrderRequest/Response`,
`SubmitRevealRequest` (0x81 PSBT `[commit] -> [parent return, child]`), `RescueInputs` (what the browser
needs to re-sign a rescue; never a transaction), `ServiceConfig` (with `collectionAddress` and
`parentValueSats`, the parent return the browser signs up front), `FeesResponse`, `QueueResponse`
(block lane: `weightBudget`, `inFlightWeight`), `Tier` / `TIERS`, `TierRule` (`sharesBlock`),
`HealthResponse`, `ApiErrorCode`, `ApiErrorBody`, and `OrderStatusEvent` (payload of the
`degent.mint.order.{status}` events).

## Commands

```bash
pnpm --filter @bsh/degent-mint-sdk test
pnpm --filter @bsh/degent-mint-sdk typecheck
```
