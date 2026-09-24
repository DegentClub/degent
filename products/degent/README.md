# degent.club: own

**degent.club** is the Decentralized Gentlemen Club: a collection of 4,112 inscriptions (~1.51 GB, items from
205 KB to 3.96 MB) and the automated mint that lets anyone add a Degent, up to a block-sized one, from the website
with no human in the loop. What the user sees before paying is exactly what lands on chain.

The mint architecture (non-custodial commit/reveal, parent co-signing by a policy signer, standard vs block lanes,
self-rescue) is decided in [ADR-0002](../../docs/adr/0002-degent-mint-architecture.md). Read it before touching
anything that signs or broadcasts.

## Product map

```
 browser                                        server
 ┌──────────────────────────────┐              ┌───────────────────────────────────────┐
 │ @bsh/degent-web  (apps/web)  │  HTTP API    │ @bsh/degent-mint  (services/mint)     │
 │  connect wallet, validate,   │─────────────▶│  order state machine, art review,     │
 │  preview, quote, half-sign   │ contracts/   │  policy signer (parent), lanes,       │
 │  reveal, pay, track, rescue  │ openapi/     │  verification; emits degent.mint.*    │
 └──────┬──────────┬────────────┘ degent-mint  └──────┬───────────────┬────────────────┘
        │          │                                   │               │ contracts/asyncapi/degent-mint.yaml
        ▼          ▼                                   ▼               ▼
 @bsh/wallet-kit  @bsh/degent-mint-sdk (packages/mint-sdk) ◀── shared rules, types, API client
 (platform)       @bsh/inscription (platform) ◀── envelope, commit/reveal, exact weight + fee maths
```

## Components

| Component | Package | Kind | Path | What it does |
|---|---|---|---|---|
| `degent-web` | `@bsh/degent-web` | app | [`apps/web`](apps/web) | Mint front end: any wallet, create, validate, preview, quote, pay, track, rescue |
| `degent-mint` | `@bsh/degent-mint` | service | [`services/mint`](services/mint) | Order state machine, automated art review, parent co-signing, lane broadcaster |
| `degent-mint-sdk` | `@bsh/degent-mint-sdk` | library | [`packages/mint-sdk`](packages/mint-sdk) | Mint rules (tiers, content validation), domain types, typed API client |
| `degent-telegram-gate` | `@bsh/degent-telegram-gate` | service | [`services/telegram-gate`](services/telegram-gate) | Holders-only Telegram gate: /verify link, SIWB challenge, Register holder check, single-use invite by DM, re-verification |
| `degent-x-bot` | `@bsh/degent-x-bot` | service | [`services/x-bot`](services/x-bot) | X content engine: approval-tier classifier, content safety, Register-fact drafts behind a review queue |

Platform dependencies: [`@bsh/inscription`](../../deps/scribbit/platform/inscription),
[`@bsh/wallet-kit`](../../deps/scribbit/platform/wallet-kit) and [`@bsh/events`](../../deps/scribbit/platform/events),
from the `deps/scribbit` submodule (DegentClub/scribbit, pinned commit). Live, generated view:
`jq '.products.degent' catalog/catalog.json`.

## Contracts

- `contracts/openapi/degent-mint.yaml`: HTTP API (provided by `degent-mint` and `degent-mint-sdk`, consumed by `degent-web`).
- `contracts/asyncapi/degent-mint.yaml`: `degent.mint.*` order events (provided by `degent-mint`); must stay
  compatible with the platform-owned topic in `deps/scribbit/contracts/asyncapi/platform-events.yaml`
  (asserted in `services/mint/test/contract.test.ts`).
- Consumes `events:block.indexed.{network}` from the chain indexers.

## Where to start

```bash
pnpm --filter @bsh/degent-web dev     # front end
pnpm --filter @bsh/degent-mint dev    # service, in-memory adapters, regtest-safe
pnpm --filter "./products/degent/**" test
```

- Changing **rules** (sizes, MIME types, tiers): `packages/mint-sdk/src/rules.ts`; front end and service both use it.
- Changing **fees / weight / tx construction**: `deps/scribbit/platform/inscription` — a platform change in
  DegentClub/scribbit, then a pin bump here (tests compare predictions against real signed transactions).
- Changing the **order lifecycle**: `services/mint/src/domain/state-machine.ts`, then the AsyncAPI contract.
- Adding an **external integration**: add a port in `services/mint/src/ports/` and an adapter in `src/adapters/`.
