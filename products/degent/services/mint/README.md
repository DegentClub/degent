# @bsh/degent-mint

Automated, non-custodial mint service for degent.club (ADR-0002). Takes an order, reviews the art before
payment, stores the user's half-signed reveal, watches for the commit, attaches the collection parent,
has the policy signer co-sign input 0, broadcasts through the tier's lane, then tracks the order to
`delivered` after checking ord serves the exact bytes. If it cannot reveal in time, the user gets a
parent-less self-rescue transaction.

Contracts: [`contracts/openapi/degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml) (HTTP) and
[`contracts/asyncapi/degent-mint.yaml`](../../../../contracts/asyncapi/degent-mint.yaml) (events). Shared rules,
types and the typed client: [`@bsh/degent-mint-sdk`](../../packages/mint-sdk/README.md). All weight, fee,
commit-address and PSBT maths: `@bsh/inscription`.

## Architecture (ports and adapters)

```mermaid
flowchart LR
  subgraph Browser["Browser (@bsh/degent-web)"]
    K["ephemeral K_e<br/>buildHalfSignedReveal (0x83)"]
  end
  subgraph Service["@bsh/degent-mint"]
    API["app.ts<br/>Hono HTTP API<br/>CORS / limits / rate limit / bearer orderToken"]
    OS["application/order-service.ts<br/>use cases + transitions"]
    SM["domain/state-machine.ts<br/>allowed-transitions table"]
    POL["domain/policy.ts<br/>ADR §3 parent policy"]
    W["worker.ts<br/>deterministic tick()"]
  end
  subgraph Ports
    OSt[(OrderStore)]
    CS[(ContentStore)]
    RV[(RevealVault<br/>AES-256-GCM)]
    CH[ChainPort]
    FE[FeePort]
    BR[Broadcaster per lane]
    PS[PolicySigner]
    AR[ArtReview]
    PU[ParentUtxoProvider]
    EB[EventBus]
    CL[Clock]
  end
  K -- "POST /orders, PUT /content,<br/>POST /reveal (Bearer orderToken)" --> API
  API --> OS --> SM
  W --> OS
  OS --> OSt & CS & RV & AR & EB
  W --> CH & PU & PS & BR & RV
  PS --> POL
  OSt -.-> MemOS["memory / node:sqlite"]
  CS -.-> FsCS["filesystem (sha256-addressed) / memory"]
  RV -.-> SQ["sqlite `reveals` table / memory"]
  CH -.-> ESP["esplora REST + ord /content"]
  FE -.-> ESPF["esplora /fee-estimates / static"]
  BR -.-> STD["standard: esplora POST /tx"]
  BR -.-> BLK["block: Libre Relay sendrawtransaction<br/>+ MARA Slipstream (fan-out)"]
  PS -.-> MEM["in-memory key (dev/test only)<br/>KMS/HSM (TODO)"]
  AR -.-> RULES["rules: magic bytes + header dims"]
  AR -.-> VIS["vision: Claude (optional)"]
  EB -.-> BUS["in-memory / RabbitMQ (TODO)"]
```

Layout:

| Path | What |
|---|---|
| `src/domain/` | Pure: state machine, parent policy, quote maths (via `@bsh/inscription`), address checks, errors |
| `src/ports/` | Interfaces only |
| `src/adapters/` | Implementations: stores, vault, esplora chain/fees, broadcasters, signers, reviewers, bus |
| `src/application/` | `OrderService` (API use cases, every transition), settings, logger |
| `src/app.ts` | HTTP API |
| `src/worker.ts` | Order progression |
| `src/config.ts`, `env.schema.json` | Env -> typed config, fail-fast |
| `src/wiring.ts`, `src/main.ts` | Composition root and entry point |
| `test/fakes/` | Fake chain + ord, clock, broadcasters, reviewer, test harness and "browser" |

## Order lifecycle

```
awaiting_content -> reviewing -> approved | rejected
approved -> awaiting_payment              (half-signed reveal verified + stored)
awaiting_payment -> paid -> queued -> revealing -> revealed -> confirmed -> verified -> delivered
pre-paid states -> expired  (expired -> paid if the commit is funded late: the fee is fixed in the commit)
paid | queued | revealing -> rescue_available -> revealed (commit spent on chain: rescue or late reveal)
awaiting_payment -> failed (commit funded with the wrong value/script), confirmed -> failed (ord bytes differ)
revealing -> queued (broadcast rejected; lease released)
```

The table in `src/domain/state-machine.ts` is authoritative; illegal transitions throw. Every transition is
persisted with a timestamp in `timeline` and emitted as `degent.mint.order.<status>`.

## How the pieces fit

1. **POST /v1/orders** validates metadata with the SDK rules, the recipient (taproot, right network), `K_e`
   (valid x-only point) and fee rate, and returns an *indicative* quote (weight depends only on length, so
   it already equals the binding weight) plus a one-time random `orderToken` (only its SHA-256 is stored).
2. **PUT /v1/orders/{id}/content** (Bearer token): length and SHA-256 must match the declaration; the
   `ArtReview` chain (rules, then optional vision) runs **before** any transition. Approved content is stored
   content-addressed and the *binding* quote (with `commitAddress`) is returned.
3. **POST /v1/orders/{id}/reveal** (Bearer token): `verifyHalfSignedReveal` against the stored bytes,
   recipient, postage, commit outpoint and value; also proven rescuable. The PSBT is sensitive (a holder can
   restructure a 0x83 reveal before broadcast), so it is stored AES-256-GCM encrypted (AAD = order id) in a
   separate `reveals` table, never logged, emitted, or returned.
4. **Worker tick**: chain progress first (confirmations, ord verification, delivery, rescue spends), then
   payment detection (exact value and script), expiry, queueing, retries, rescue timeouts, and dispatch:
   lease parent -> `attachParent` -> `PolicySigner.sign` (policy check, then `signParentInput`) ->
   `finalizeReveal` (weight asserted equal to the quote) -> lane broadcaster. On success the new parent is
   output 0 of that reveal.
5. **Lanes.** Block lane: one reveal in flight (revealing or unconfirmed). Standard lane:
   `STANDARD_CONCURRENCY` in flight, may chain on unconfirmed standard parents, never on an unconfirmed
   block-lane parent. New Block Degent orders are refused (`queue_full`) when the queue ETA would exceed
   80% of the rescue timeout.

Policy signer (ADR §3), stricter in one respect: the parent return must equal the parent input value
**exactly** (a larger output 0 would swallow the child sat). It also checks the commit script, recipient,
postage, the lane fee band and that the fee rate matches the quote. A refusal moves the order straight to
`rescue_available`.

## API summary

| Method | Path | Auth | Result |
|---|---|---|---|
| GET | `/v1/health` | - | status + checks (store, chain, parent) |
| GET | `/v1/config` | - | collection rules, tiers, collection address, upload limit |
| GET | `/v1/fees` | - | sat/vB per lane |
| GET | `/v1/queue` | - | lane waiting / in-flight / capacity / ETA |
| POST | `/v1/orders` | - | 201 `{ order, orderToken }` |
| PUT | `/v1/orders/{id}/content` | Bearer | raw bytes (`application/octet-stream`, <= 4 MiB) -> approved/rejected order |
| POST | `/v1/orders/{id}/reveal` | Bearer | `SubmitRevealRequest` -> `awaiting_payment` |
| GET | `/v1/orders/{id}` | - | public order (no PSBT, no token) |
| GET | `/v1/orders/{id}/rescue` | Bearer | rescue tx hex when `rescue_available`, else 409 |

Errors are always `{ "error": { "code", "message", "details"? } }`. 401 = no/malformed token, 403 = wrong
token or disallowed origin, 413 body too large, 415 wrong content type, 422 validation, 429 rate limited.

## Configuration

See [`env.schema.json`](./env.schema.json) for every variable. Essentials:

| Variable | Notes |
|---|---|
| `NETWORK` | required; `regtest` enables dev defaults (in-memory stores, dev reveal key, random parent key) |
| `DATABASE_PATH`, `CONTENT_DIR` | sqlite file and blob dir (required off regtest) |
| `ESPLORA_URL`, `ORD_URL` | chain + ord backends |
| `LIBRE_RPC_URL/USER/PASS`, `SLIPSTREAM_URL/API_KEY` | block lane (mainnet needs at least one; both = fan-out) |
| `PARENT_INSCRIPTION_ID`, `PARENT_OUTPOINT`, `COLLECTION_ADDRESS` | parent identity, initial location, key address |
| `SIGNER`, `PARENT_KEY_FILE` | `memory` + key file is dev-only; **mainnet refuses to start** with it (KMS adapter TODO) |
| `REVEAL_ENCRYPTION_KEY` | 32-byte hex AES key for stored reveals (required off regtest) |
| `CORS_ORIGINS` | exact origins, comma-separated; empty = deny all |
| `ART_REVIEW_API_KEY` | enables the Claude vision review (`claude-opus-5`); unset = rules only |
| `SERVICE_FEE_ADDRESS`, `SERVICE_FEE_SATS_*` | optional service fee, paid in the funding tx |

Config errors are listed all at once and the process exits non-zero.

## Run locally

```bash
pnpm --filter @bsh/degent-mint dev          # NETWORK=regtest, in-memory, http://127.0.0.1:8787
curl -s localhost:8787/v1/config | jq .

# against a local regtest esplora + ord
NETWORK=regtest ESPLORA_URL=http://127.0.0.1:3002 ORD_URL=http://127.0.0.1:8080 \
  PARENT_OUTPOINT=<txid>:<vout> PARENT_KEY_FILE=./dev-parent.key \
  CORS_ORIGINS=http://localhost:5173 pnpm --filter @bsh/degent-mint dev

pnpm --filter @bsh/degent-mint test         # unit + API + worker + e2e on a fake regtest chain
pnpm --filter @bsh/degent-mint typecheck
```

Operations: [RUNBOOK.md](./RUNBOOK.md).

## Known gaps

- KMS/HSM `PolicySigner` is an interface only (`src/adapters/kms-policy-signer.ts`); mainnet cannot start until it exists.
- RabbitMQ `EventBus` adapter is an interface only; events currently go to the in-process bus.
- The rate limiter is per process; run one API replica or put a shared limiter in front.
- The service trusts one esplora; a second backend for cross-checking payment detection is future work.
