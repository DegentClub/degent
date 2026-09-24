# @bsh/degent-mint

Automated, non-custodial mint service for degent.club (ADR-0002, ADR-0005, ADR-0007). Four stages — **Design → Mint →
Confirm → Approve**: takes an order, reviews the art before payment, stores the user's half-signed reveal,
watches for the commit and its confirmation, opens a **member review** in which existing Degent holders vote
with BIP-322 signatures, and only on the approval quorum attaches the collection parent, has the policy signer
co-sign input 0, broadcasts through the tier's lane, then tracks the order to `delivered` after checking ord
serves the exact bytes. If the members decline, or nobody decides within the review SLA, or it cannot reveal in
time, the user gets the parameters to re-sign a parent-less self-rescue with their own key (ADR-0005). It also serves the **Register** (the club's roll:
the 4,112 Gallery members from `data/roster.json` plus every approved child).

Contracts: [`contracts/openapi/degent-mint.yaml`](../../../../contracts/openapi/degent-mint.yaml) (HTTP) and
[`contracts/asyncapi/degent-mint.yaml`](../../../../contracts/asyncapi/degent-mint.yaml) (events). Shared rules,
types and the typed client: [`@bsh/degent-mint-sdk`](../../packages/mint-sdk/README.md). All weight, fee,
commit-address and PSBT maths: `@bsh/inscription`.

## Architecture (ports and adapters)

```mermaid
flowchart LR
  subgraph Browser["Browser (@bsh/degent-web)"]
    K["ephemeral K_e (kept encrypted in the recovery bundle)<br/>buildHalfSignedReveal (0x81)<br/>buildResignedRescue"]
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
awaiting_content -> reviewing -> approved | rejected                      (Design)
approved -> awaiting_payment              (half-signed reveal verified + stored)
awaiting_payment -> paid -> confirming                                    (Mint, Confirm)
confirming -> member_review               (commit confirmed; members vote, ADR-0007)   (Approve)
member_review -> queued (APPROVAL_QUORUM; Degent number = 4112 + rank) | declined (DECLINE_QUORUM)
member_review -> rescue_available         (no decision within REVIEW_SLA_SECONDS, default 14 days)
queued -> revealing -> revealed -> confirmed -> verified -> delivered
pre-paid states -> expired  (expired -> paid if the commit is funded late: the fee is fixed in the commit)
paid | confirming | queued | revealing -> rescue_available (timeout from payment, or from approval once approved)
rescue_available | declined -> revealed (commit spent on chain: self-rescue without the parent, or late reveal)
awaiting_payment -> failed (commit funded with the wrong value/script), confirmed -> failed (ord bytes differ)
revealing -> queued (broadcast rejected; lease released)
revealing -> rescue_available (policy refusal, or the parent's value differs from the one the user signed, ADR-0005)
```

The table in `src/domain/state-machine.ts` is authoritative; illegal transitions throw. Every transition is
persisted with a timestamp in `timeline` and emitted as `degent.mint.order.<status>`.

## How the pieces fit

1. **POST /v1/orders** validates metadata with the SDK rules, the recipient (taproot, right network), `K_e`
   (valid x-only point) and fee rate, and returns an *indicative* quote (weight depends only on length, so
   it already equals the binding weight) plus a one-time random `orderToken` (only its SHA-256 is stored).
   Every quote carries `parentReturnAddress` (the collection address) and `parentValueSats` (the current parent
   UTXO value), which the browser signs as output 0 of the reveal.
2. **PUT /v1/orders/{id}/content** (Bearer token): length and SHA-256 must match the declaration; the
   `ArtReview` chain (rules, then optional vision) runs **before** any transition. Approved content is stored
   content-addressed and the *binding* quote (with `commitAddress`) is returned. Refused with 503
   `upstream_unavailable` (before review) while the parent UTXO is unknown.
3. **POST /v1/orders/{id}/reveal** (Bearer token): `verifyHalfSignedReveal` in SIGHASH_ALL|ANYONECANPAY
   (0x81) mode against the stored bytes, recipient, postage, commit outpoint and value **and** the quote's
   parent return address and value (output 0); 0x83 reveals are refused (ADR-0005). The PSBT is stored
   AES-256-GCM encrypted (AAD = order id) in a separate `reveals` table, never logged, emitted, or returned.
4. **Worker tick**: chain progress first (confirmations, ord verification, delivery, rescue spends), then
   payment detection (exact value and script), expiry, queueing, retries, rescue timeouts, and dispatch:
   lease parent -> signed parent value == leased parent value (else `rescue_available`) -> `attachParent` ->
   `PolicySigner.sign` (policy check incl. the 0x81 hash type on input 1, then `signParentInput`) ->
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

## Art review and the advisory minting rules

The review runs on upload, before payment (`CompositeArtReview`: `rules`, then the optional `vision` reviewer).
Its result (`ReviewResult`, `contracts/openapi/degent-mint.yaml`) has two independent parts:

1. **Hard verdict** — `approved` / `reasons`. Only the file rules (type sniffed from the bytes, size tier,
   256–4096 px) and the six safety categories in `DEFAULT_GUIDELINES` (explicit or child sexual content, gore,
   hate, personal data, scams, blank/noise images) can reject. A vision refusal rejects; a vision outage or an
   off-schema reply is a 503 and the upload can be retried (nobody is rejected because a dependency was down).
2. **Advisory rules** — `rules: { square, pepeInTuxWithBowtie, framedWithPlacard, placardText, notes }`, the
   site's four Minting Rules (`MINTING_RULES` in `@bsh/degent-mint-sdk`, verbatim from the site). Each verdict is
   `pass | fail | unknown`; `placardText` is `DEGEN | DEGENT | REGEN | null`. **They never reject.**
   - `square`: exact, from the decoded image header (rules reviewer).
   - `pepeInTuxWithBowtie`, `framedWithPlacard`, `placardText`: from the vision reviewer; `unknown`/`null`
     without it (no key, AVIF, > 3.7 MB, refusal).
   - Merge: per rule the earliest reviewer with a pass/fail wins (`mergeRuleAdvice`), so the measured `square`
     beats any model estimate. Rule 1's JPEG/200 KB part is the hard size check; rule 4 (quantity) needs none.

**UI contract** (web renders it later; nothing else is needed from the API):

| Where | Data | Rendering |
|---|---|---|
| Design → Validate, after `PUT /v1/orders/{id}/content`, **before payment** | `order.review.rules` | Four rule cards in `MINTING_RULES` order (title + verbatim text). Badge per rule: `pass` ✓ green, `fail` ⚠ amber "does not seem to follow this rule", `unknown` grey "not checked automatically". Show `notes[rule]` under the badge; show `placardText` when non-null. Never block the pay button on a `fail`; say that members see the same check when they vote. Rule 4 is always shown as informational. |
| Member review (`GET /v1/review`) | `items[].order.review.rules` | Same badges, compact, next to the tally. `fail` is information for the voter, not a recommendation. |
| Either, when `rules` is absent | — | Hide the block (orders reviewed before this field existed). |

## Member approval (ADR-0007)

`application/approval-service.ts` wires the platform's SIWB (`issueChallenge` / `verifySignIn`, nonce store in
memory or sqlite) and `SessionKeyRing` to orders and holders; `domain/approval.ts` holds the pure rules (one vote
per address per order, holder at vote time, no self-votes, exact statement, quorums, `4112 + rank`).
`ports/holder-registry.ts` answers who is a member: `adapters/memory-holder-registry.ts` (tests, regtest) or
`adapters/roster-chain-holder-registry.ts` (roster JSON + ord `/r/inscription`, `/r/utxo` + esplora, injectable
fetch, 60 s cache). `application/register-service.ts` serves the Register from the roster plus delivered children.

Scripts: `scripts/build-roster.mjs` (marketplace manifest → `data/roster.json`), `scripts/register-batch.mjs`
(newly approved members + approver signatures as JSON for the owner to inscribe), `scripts/blockspace-query.mjs`
(reproducible blockspace report). Settings: `APPROVAL_QUORUM`, `DECLINE_QUORUM`, `REVIEW_SLA_SECONDS`,
`SIWB_DOMAIN`, `SIWB_URI`, `SESSION_KEY`, `SESSION_KID`, `SESSION_TTL_SECONDS`, `HOLDER_REGISTRY`, `ROSTER_FILE`,
`ORD_PUBLIC_URL`, `GALLERY_INSCRIPTION_ID` (see `env.schema.json`).

## API summary

| Method | Path | Auth | Result |
|---|---|---|---|
| GET | `/v1/health` | - | status + checks (store, chain, parent) |
| POST | `/v1/auth/challenge` | - | SIWB challenge for a holder address (`@bsh/identity`) |
| POST | `/v1/auth/verify` | - | verify the signed challenge; holder session token (403 `not_a_holder` otherwise) |
| GET | `/v1/review` | holder session | orders in `member_review` with tallies |
| POST | `/v1/orders/{id}/votes` | holder session | cast a BIP-322-signed vote (`Approve Degent order <id> (<ref>)`) |
| GET | `/v1/orders/{id}/votes` | - | public tally + signed votes (voters' Degent numbers, never addresses) |
| GET | `/v1/register`, `/v1/register/{n}`, `/v1/register/holder/{address}`, `/v1/register/verify/{id}` | - | the Register |
| GET | `/v1/explorer`, `/v1/stats` | - | paginated members with image URLs; collection statistics |
| GET | `/v1/config` | - | collection rules, tiers, collection address, upload limit |
| GET | `/v1/fees` | - | sat/vB per lane |
| GET | `/v1/queue` | - | lane waiting / in-flight / capacity / ETA |
| POST | `/v1/orders` | - | 201 `{ order, orderToken }` |
| PUT | `/v1/orders/{id}/content` | Bearer | raw bytes (`application/octet-stream`, <= 4 MiB) -> approved/rejected order |
| POST | `/v1/orders/{id}/reveal` | Bearer | `SubmitRevealRequest` -> `awaiting_payment` |
| GET | `/v1/orders/{id}` | - | public order (no PSBT, no token) |
| GET | `/v1/orders/{id}/rescue` | Bearer | rescue *parameters* (incl. content bytes) for `buildResignedRescue` when `rescue_available` or `declined`, else 409; the browser signs with K_e |

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
| `ART_REVIEW_API_KEY` | enables the Claude vision review (model: the `ART_REVIEW_MODEL` constant in `src/adapters/claude-art-review.ts`); unset = rules only |
| `ART_REVIEW_GUIDELINES_FILE` | optional replacement for `DEFAULT_GUIDELINES` (the verdict schema is fixed) |
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

Operations: [RUNBOOK.md](./RUNBOOK.md); dashboard + alerts from the JSON logs: [products/degent/ops](../../ops/README.md). One certified count (roster vs export vs ord vs the site claims): `scripts/reconcile-count.mjs` ([REGISTER.md §2.1](../../../../docs/REGISTER.md)). Launch (Club parent, signed Gallery, env): [docs/LAUNCH-CHAIN-SETUP.md](../../../../docs/LAUNCH-CHAIN-SETUP.md).

## Known gaps

- KMS/HSM `PolicySigner` is an interface only (`src/adapters/kms-policy-signer.ts`); mainnet cannot start until it exists.
- RabbitMQ `EventBus` adapter is an interface only; events currently go to the in-process bus.
- The rate limiter is per process; run one API replica or put a shared limiter in front.
- The service trusts one esplora; a second backend for cross-checking payment detection is future work.
