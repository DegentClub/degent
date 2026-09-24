# degent.club: own

**degent.club** is the Decentralized Gentlemen Club: a collection of 4,112 inscriptions (~1.51 GB, items from
205 KB to 3.96 MB) and the automated mint that lets anyone add a Degent, up to a block-sized one, from the website
with no human in the loop. What the user sees before paying is exactly what lands on chain.

The mint architecture (non-custodial commit/reveal, parent co-signing by a policy signer, standard vs block lanes,
self-rescue) is decided in [ADR-0002](../../docs/adr/0002-degent-mint-architecture.md), amended by
[ADR-0005](../../docs/adr/0005-strict-reveal-and-tiers.md): reveals are signed SIGHASH_ALL|ANYONECANPAY with the
parent return pre-committed, the user keeps the one-time key K_e in their recovery bundle and re-signs the rescue,
and there are three tiers by content bytes — **Standard Degent** (200-400 KB), **Large Degent** (400 KB-3.5 MB),
**Full Block Degent** (3.5-3.9 MB) — while the lane is decided by reveal weight and the block lane packs reveals
into a 3,990,000 WU per-block budget (a Full Block Degent always alone). Read both before touching anything that
signs or broadcasts.

## Product map

```
 browser                                        server
 ┌──────────────────────────────┐              ┌───────────────────────────────────────┐
 │ @bsh/degent-web  (apps/web)  │  HTTP API    │ @bsh/degent-mint  (services/mint)     │
 │  connect wallet, validate,   │─────────────▶│  order state machine, art review,     │
 │  preview, quote, half-sign   │ contracts/   │  policy signer (parent), lanes,       │
 │  reveal, pay, track, rescue  │ openapi/     │  verification; emits degent.mint.*    │
 │                              │ degent-mint  └──────┬───────────────┬──────┬─────────┘
 │  studio: sign in with        │                     │               │      │ POST /v1/internal/royalties
 │  Bitcoin, prove payout,      │  HTTP API    ┌──────┴───────────────┴──────▼─────────┐
 │  submit, gallery, royalties  │─────────────▶│ @bsh/degent-studio (services/studio)  │
 └──────┬──────────┬────────────┘ contracts/   │  SIWB artists, BIP-322 payout proof,  │
        │          │              openapi/      │  artwork reviewed once, gallery,      │
        │          │              degent-studio │  royalty view; emits degent.artwork.* │
        ▼          ▼                            └───────────────────────────────────────┘
 @bsh/wallet-kit  @bsh/degent-mint-sdk (packages/mint-sdk) ◀── shared rules (DEGENT_RULES), types, API client
 (platform)       @bsh/inscription (platform) ◀── envelope, commit/reveal, exact weight + fee maths
                  @bsh/identity, @bsh/edge, @bsh/events (platform) ◀── SIWB / BIP-322 / sessions, edge middleware, event bus
```

## Components

| Component | Package | Kind | Path | What it does |
|---|---|---|---|---|
| `degent-web` | `@bsh/degent-web` | app | [`apps/web`](apps/web) | Mint front end: any wallet, create, validate, preview, quote, pay, track, rescue |
| `degent-mint` | `@bsh/degent-mint` | service | [`services/mint`](services/mint) | Order state machine, automated art review, parent co-signing, lane broadcaster |
| `degent-mint-sdk` | `@bsh/degent-mint-sdk` | library | [`packages/mint-sdk`](packages/mint-sdk) | Mint rules (three tiers, lane-by-weight, block-lane packing, content validation), domain types, typed API client |
| `degent-market` | `@bsh/degent-market` | library | [`packages/market`](packages/market) | Non-custodial marketplace txs: seller 0x83 listings, buyer purchases with padding inputs so the inscription lands with the buyer (ordinal FIFO proved in tests) |
| `degent-studio` | `@bsh/degent-studio` | service | [`services/studio`](services/studio) | Artist Studio (ADR-0007): Sign-in-with-Bitcoin artists, BIP-322-proven payout address, artworks reviewed once against the Degent rules (rules + vision, a skipped check never approves), public gallery, royalty view fed by the mint |

Platform dependencies: [`@bsh/inscription`](../../deps/scribbit/platform/inscription),
[`@bsh/wallet-kit`](../../deps/scribbit/platform/wallet-kit), [`@bsh/events`](../../deps/scribbit/platform/events),
[`@bsh/identity`](../../deps/scribbit/platform/identity) and [`@bsh/edge`](../../deps/scribbit/platform/edge),
from the `deps/scribbit` submodule (DegentClub/scribbit, pinned commit). Live, generated view:
`jq '.products.degent' catalog/catalog.json`.

## Contracts

- `contracts/openapi/degent-mint.yaml`: HTTP API (provided by `degent-mint` and `degent-mint-sdk`, consumed by `degent-web`).
- `contracts/asyncapi/degent-mint.yaml`: `degent.mint.*` order events (provided by `degent-mint`); must stay
  compatible with the platform-owned topic in `deps/scribbit/contracts/asyncapi/platform-events.yaml`
  (asserted in `services/mint/test/contract.test.ts`).
- Consumes `events:block.indexed.{network}` from the chain indexers.
- `contracts/openapi/degent-studio.yaml`: the Artist Studio HTTP API (provided by `degent-studio`; the web app and,
  for royalty records, the mint service consume it).
- `contracts/asyncapi/degent-studio.yaml`: `degent.artwork.{status}` events (provided by `degent-studio`).
- `contracts/schemas/degent-rules.json`: the published Degent rules as a JSON Schema (provided by `degent-mint-sdk`,
  mirrored by `DEGENT_RULES` in code).

## Where to start

```bash
pnpm --filter @bsh/degent-web dev     # front end
pnpm --filter @bsh/degent-mint dev    # service, in-memory adapters, regtest-safe
pnpm --filter @bsh/degent-studio dev  # artist studio, in-memory adapters, dev API keys printed once
pnpm --filter "./products/degent/**" test
pnpm --filter @bsh/degent-web e2e     # real headless Chromium, screenshots in apps/web/docs/screenshots
```

- Changing **rules** (sizes, MIME types, tiers): `packages/mint-sdk/src/rules.ts`; front end and service both use it.
  The published rule list (text + who checks it) is `packages/mint-sdk/src/degent-rules.ts` and
  `contracts/schemas/degent-rules.json` (kept equal by a test).
- Changing the **studio** (artist identity, payout proof, artwork review, gallery, royalties): `services/studio`
  (ADR-0007); its lifecycle is `services/studio/src/domain/artwork.ts`, then the AsyncAPI contract.
- Changing **block-lane scheduling**: `packages/mint-sdk/src/queue.ts` (packing maths) + `services/mint/src/worker.ts` (dispatch).
- Changing **marketplace transactions**: `packages/market` (prove placement with `simulateOrdinalTransfer`).
- Changing **fees / weight / tx construction**: `deps/scribbit/platform/inscription` — a platform change in
  DegentClub/scribbit, then a pin bump here (tests compare predictions against real signed transactions).
- Changing the **order lifecycle**: `services/mint/src/domain/state-machine.ts`, then the AsyncAPI contract.
- Adding an **external integration**: add a port in `services/mint/src/ports/` and an adapter in `src/adapters/`.
