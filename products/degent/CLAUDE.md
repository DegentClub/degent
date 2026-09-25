# degent.club - agent notes

Read the root `CLAUDE.md`, then [ADR-0002](../../docs/adr/0002-degent-mint-architecture.md) and
[ADR-0005](../../docs/adr/0005-strict-reveal-and-tiers.md) (which supersedes ADR-0002 §1, §2, §6). This product moves
real bitcoin; the rules below are not style preferences.

Vocabulary (ADR-0005): **tiers** by content bytes — `standard` Standard Degent (200-400 KB), `large` Large Degent
(400 KB-3.5 MB), `fullblock` Full Block Degent (3.5-3.9 MB); **lanes** by reveal weight — `standard` (<= 400,000 WU)
or `block` (packed into a 3,990,000 WU per-block budget; a Full Block Degent always alone). Never derive a lane from
a tier.

## Map

| Path | Package | Kind |
|---|---|---|
| (website) | `@bsh/degent-web` | app in [DegentClub/degent.club](https://github.com/DegentClub/degent.club) (`apps/web`) |
| `services/mint` | `@bsh/degent-mint` | service (Hono, ports and adapters) |
| `packages/mint-sdk` | `@bsh/degent-mint-sdk` | library (rules, tiers, lane/queue maths, types, API client) |
| `packages/market` | `@bsh/degent-market` | library (seller 0x83 listings, padded buyer purchases, ordinal FIFO simulator) |

Query `catalog/catalog.json` (`.products.degent`, `.components[] | select(.product=="degent")`) for the current
dependency and contract graph instead of reading package.json files.

## Hard rules

1. **Non-custodial.** The service never holds a key that can move user funds. The ephemeral reveal key `K_e` is
   generated in the browser and kept only in the user's recovery bundle (it controls nothing but that user's
   commit output); the server only stores half-signed 0x81 reveals and never sees `K_e`. The rescue is re-signed
   in the browser; `GET /rescue` returns inputs, never a transaction.
2. **Only the policy signer signs the parent input**, and only transactions matching ADR-0002 section 3.
   Never widen its checks to make a test pass. Reveals are SIGHASH_ALL|ANYONECANPAY with output 0 =
   (collection address, `PARENT_VALUE_SATS`) signed by the browser; never accept 0x83.
3. **One implementation of the maths.** Weight, fee and commit address come from `@bsh/inscription`; rules come
   from `@bsh/degent-mint-sdk`. Do not re-derive them in the app or the service.
4. **Contract first.** API or event changes start in `contracts/openapi/degent-mint.yaml` /
   `contracts/asyncapi/degent-mint.yaml`. The order-status topic is shared and owned by the platform
   (`deps/scribbit/contracts/asyncapi/platform-events.yaml`); keep `OrderStatusEvent` compatible with it.
5. **Imports:** only `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/degent-mint-sdk`, `@bsh/events`, each only where declared in
   that component's `depends_on`. Platform packages come from the `deps/scribbit` submodule; never edit them in
   place. Never import `blockspace` or `scribbit` code; `pnpm lint:boundaries` fails.
6. **Tests with fakes.** Service tests use the in-memory adapters (`memory-order-store`, `in-memory-policy-signer`,
   `rules-art-review`); nothing in tests touches mainnet.

## Verify before finishing

```bash
pnpm --filter "./products/degent/**" typecheck
pnpm --filter "./products/degent/**" test
pnpm validate && pnpm lint:boundaries && pnpm catalog --check
```
