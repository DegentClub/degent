# @bsh/meter-client

Typed, zero-dependency client for the **live block.space Meter API** (`https://block.space/api/*`): the public
source of truth for Bitcoin blockspace (books **A** = attributed blockspace, **B**, **C** = content bytes;
denominations `bytes` | `vbytes`). Runs anywhere `fetch` exists (Node ≥ 22, browsers, workers).

It does not cache, paginate automatically or talk to any other API. It **fails loudly on contract drift**: every
2xx body is shape-checked and a mismatch throws `MeterContractError` listing each offending JSON path.

```ts
import { MeterClient, MeterContractError } from '@bsh/meter-client';

const meter = new MeterClient({ timeoutMs: 10_000, retries: 2 });
const { chain_tip } = await meter.meter();
const top = await meter.tokens({ book: 'a', denom: 'bytes', limit: 50 }, { signal: AbortSignal.timeout(30_000) });
const block = await meter.block(840_000);
```

| Method | Endpoint |
|---|---|
| `tokens(query?)` | `GET /api/tokens?book&denom&sort&protocol&q&limit&offset` |
| `token(protocol, ref)` | `GET /api/token/<protocol>/<ref>` (flat row, no `rn`/`attributed`) |
| `protocols(book?, denom?)` | `GET /api/protocols` |
| `growth(bucket?)` | `GET /api/growth?bucket` |
| `meter()` / `frontier()` / `summary()` / `landmarks()` | `GET /api/meter` … |
| `block(height)` | `GET /api/block/<height>` |

## Behaviour

- **Retries** (default 2): network errors, per-attempt timeouts and HTTP 408/425/429/500/502/503/504, with
  full-jitter exponential backoff (`backoff.baseMs` 250, `maxMs` 5000). `Retry-After` is honoured (capped).
  Other 4xx and contract drift are never retried.
- **Timeouts** (`timeoutMs`, default 15 s) apply per attempt and cover reading the body.
- **Abort:** a caller `AbortSignal` cancels the attempt and any backoff sleep; its reason is rethrown unchanged.
- **Errors:** `MeterHttpError` (status, parsed body), `MeterNetworkError`, `MeterTimeoutError`,
  `MeterContractError` (issues), all `instanceof MeterError`.

## Types: what is confirmed

Types are ported from the tracker client (`skrybit-suite/tracker/src/types/blockspace.ts`), the only written
description of the API. The live API is not reachable from CI, so the rule is:

- **Required**: fields the tracker's shipped UI reads from the live API, or that the tracker notes as
  "confirmed live" (the whole `/api/token/<p>/<ref>` row).
- **Optional**: everything else it documents (`/api/summary`, most of `/api/meter`, frontier/landmark rows, …).
  Optional fields are still type-checked when present. Promote a field to required once it is confirmed.

Extra fields are accepted (additive changes are not drift). `schemas.ts` holds the runtime guards; a
compile-time assertion keeps every guard identical to its interface in `types.ts`. `/api/tx/<h>/<i>` (in the
tracker, with an unconfirmed return type) is intentionally not wrapped yet.

## Tests

`pnpm --filter @bsh/meter-client test | typecheck`. Tests never touch the network: `test/fixtures/*.json` are
responses written by hand from the type definitions (every documented field present), served by an injected
`fetch`.
