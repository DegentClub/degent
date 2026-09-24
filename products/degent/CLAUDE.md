# degent.club - agent notes

Read the root `CLAUDE.md`, then [ADR-0002](../../docs/adr/0002-degent-mint-architecture.md) and
[ADR-0005](../../docs/adr/0005-sighash-all-anyonecanpay-reveals.md) (which supersedes its §2 steps 4–5). This product moves
real bitcoin; the rules below are not style preferences.

## Map

| Path | Package | Kind |
|---|---|---|
| `apps/web` | `@bsh/degent-web` | app (React + Vite) |
| `services/mint` | `@bsh/degent-mint` | service (Hono, ports and adapters) |
| `packages/mint-sdk` | `@bsh/degent-mint-sdk` | library (rules, types, API client) |
| `services/market` | `@bsh/degent-market` | service (Hono, ports and adapters): marketplace settlement, SIWB listing auth, watcher ([ADR-0008](../../docs/adr/0008-first-party-marketplace-settlement.md), [SETTLEMENT.md](services/market/docs/SETTLEMENT.md)) |
| `packages/market-sdk` | `@bsh/degent-market-sdk` | library (listing/buy types, layout constants, royalty/fee maths, API client) |

Query `catalog/catalog.json` (`.products.degent`, `.components[] | select(.product=="degent")`) for the current
dependency and contract graph instead of reading package.json files.

## Hard rules

1. **Non-custodial.** The service never holds a key that can move user funds. The ephemeral reveal key `K_e` is
   generated in the browser, signs the reveal with `SIGHASH_ALL|ANYONECANPAY` (0x81) over both outputs, and is then
   kept only **encrypted** (recovery passphrase) in the user's recovery bundle for self-rescue (ADR-0005); it is
   never sent to the server. The server only stores half-signed reveals and rescue *parameters*.
2. **Only the policy signer signs the parent input**, and only transactions matching ADR-0002 section 3.
   Never widen its checks to make a test pass.
3. **One implementation of the maths.** Weight, fee, commit address and sat assignment (FIFO: where an inscription
   lands) come from `@bsh/inscription`; mint rules from `@bsh/degent-mint-sdk`; marketplace layout, royalty and fee
   maths from `@bsh/degent-market-sdk`. Do not re-derive them in the app or the services.
4. **Contract first.** API or event changes start in `contracts/openapi/degent-{mint,market}.yaml` /
   `contracts/asyncapi/degent-{mint,market}.yaml`. The order-status topic is shared and owned by the platform
   (`deps/scribbit/contracts/asyncapi/platform-events.yaml`); keep `OrderStatusEvent` compatible with it.
5. **Imports:** only `@bsh/inscription`, `@bsh/identity`, `@bsh/wallet-kit`, `@bsh/events`, `@bsh/degent-mint-sdk`,
   `@bsh/degent-market-sdk`, each only where declared in that component's `depends_on`. Services never import each
   other (the market reads the mint's Register through the mint SDK client). Platform packages come from the
   `deps/scribbit` submodule; never edit them in place. Never import `blockspace` or `scribbit` code; `pnpm lint:boundaries` fails.
6. **Tests with fakes.** Service tests use the in-memory adapters (`memory-order-store`, `in-memory-policy-signer`,
   `rules-art-review`; the market's `memory-store` and `test/fakes/harness.ts`); nothing in tests touches a network.
7. **Buys stay off.** `BUYS_ENABLED` defaults to `false`. Never flip the default or weaken the kill switch; enabling
   is an owner action after signet trades and an external review (ADR-0008, roadmap p3.4/p3.5/p3.13).

## Verify before finishing

```bash
pnpm --filter "./products/degent/**" typecheck
pnpm --filter "./products/degent/**" test
pnpm validate && pnpm lint:boundaries && pnpm catalog --check
```
