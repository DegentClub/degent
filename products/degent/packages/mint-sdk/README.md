# @bsh/degent-mint-sdk

Rules, domain types and the typed HTTP client for the degent.club mint, shared by the front end
(`@bsh/degent-web`) and the service (`@bsh/degent-mint`) so that what the user sees is computed from the same
definitions the service enforces. Contract: [`contracts/openapi/degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml).
Design: [ADR-0002](../../../../docs/adr/0002-degent-mint-architecture.md).

Pure TypeScript, no Node APIs: runs in the browser and in Node 22. Only dependency: `@noble/hashes`.
Transaction, weight and fee maths are **not** here; they live in `@bsh/inscription`.

## Rules (`rules.ts`)

```ts
import { DEFAULT_CONFIG, tierForSize, validateContentMeta, sha256Hex, formatSats, formatBtc, estimateTotal } from '@bsh/degent-mint-sdk';

tierForSize(250_000)?.tier;                    // 'standard'   (200,000-390,000 bytes, standard lane)
tierForSize(1_000_000)?.tier;                  // 'block'      (390,001-3,900,000 bytes, block lane)

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
256-4096 px; postage 546 sats; minimum 1 sat/vB; quote TTL 900 s; rescue after 6 h; service fee 0.
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
const rescue = await mint.getRescue(order.id, orderToken);                      // 'rescue_available' | 'declined':
// rescue parameters (content bytes included), re-signed in the browser with K_e via buildResignedRescue (ADR-0005)

try { /* ... */ } catch (e) {
  if (e instanceof ApiError) console.log(e.status, e.code, e.message, e.details);
}
```

Every endpoint is covered: `health`, `config`, `fees`, `queue`, `createOrder`, `uploadContent`,
`submitReveal`, `getOrder`, `getRescue`. Non-2xx responses and network failures raise `ApiError`
(`status` 0 and `code: 'network_error'` for the latter).

## Types (`types.ts`)

`Order`, `OrderStatus` (+ `ORDER_STATUSES`), `Quote` (`binding: false` on the indicative quote from
`POST /v1/orders`, `true` with `commitAddress` after upload; `parentReturnAddress` + `parentValueSats` are the
reveal's output 0, signed by the browser with SIGHASH_ALL|ANYONECANPAY, ADR-0005), `CreateOrderRequest/Response`,
`SubmitRevealRequest`, `RescueResponse` (rescue parameters, not a transaction), `ServiceConfig`, `FeesResponse`, `QueueResponse`,
`HealthResponse`, `ApiErrorCode`, `ApiErrorBody`, and `OrderStatusEvent` (payload of the
`degent.mint.order.{status}` events).

## Commands

```bash
pnpm --filter @bsh/degent-mint-sdk test
pnpm --filter @bsh/degent-mint-sdk typecheck
```
