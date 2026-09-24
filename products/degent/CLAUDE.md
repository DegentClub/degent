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
| `services/telegram-gate` | `@bsh/degent-telegram-gate` | service (Hono + grammY; holders-only Telegram gate on `@bsh/identity` and the Register) |
| `services/x-bot` | `@bsh/degent-x-bot` | service (X content engine: approval tiers, safety, Register-fact drafts; `brain/BRAIN.md`) |

Query `catalog/catalog.json` (`.products.degent`, `.components[] | select(.product=="degent")`) for the current
dependency and contract graph instead of reading package.json files.

## Hard rules

1. **Non-custodial.** The service never holds a key that can move user funds. The ephemeral reveal key `K_e` is
   generated in the browser, signs the reveal with `SIGHASH_ALL|ANYONECANPAY` (0x81) over both outputs, and is then
   kept only **encrypted** (recovery passphrase) in the user's recovery bundle for self-rescue (ADR-0005); it is
   never sent to the server. The server only stores half-signed reveals and rescue *parameters*.
2. **Only the policy signer signs the parent input**, and only transactions matching ADR-0002 section 3.
   Never widen its checks to make a test pass.
3. **One implementation of the maths.** Weight, fee and commit address come from `@bsh/inscription`; rules come
   from `@bsh/degent-mint-sdk`. Do not re-derive them in the app or the service.
4. **Contract first.** API or event changes start in `contracts/openapi/degent-mint.yaml`,
   `contracts/openapi/degent-telegram-gate.yaml` or `contracts/asyncapi/degent-mint.yaml`. The order-status topic is shared and owned by the platform
   (`deps/scribbit/contracts/asyncapi/platform-events.yaml`); keep `OrderStatusEvent` compatible with it.
5. **Imports:** only `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/identity`, `@bsh/degent-mint-sdk`, `@bsh/events`, each only where declared in
   that component's `depends_on`. Platform packages come from the `deps/scribbit` submodule; never edit them in
   place. Never import `blockspace` or `scribbit` code; `pnpm lint:boundaries` fails.
6. **Tests with fakes.** Service tests use the in-memory adapters (`memory-order-store`, `in-memory-policy-signer`,
   `rules-art-review`; the gate's `MemoryTelegramApi` / `MemoryHolderRegistry`; the X bot's `MemoryXClient`); nothing
   in tests touches mainnet, Telegram or X.
7. **Outbound words are gated.** Every text the X bot might post goes through `gateContent`; it posts alone only when
   the tier is `auto` and `REVIEW_QUEUE_ENABLED=false`. The Telegram gate sends invite links by DM only.

## Verify before finishing

```bash
pnpm --filter "./products/degent/**" typecheck
pnpm --filter "./products/degent/**" test
pnpm validate && pnpm lint:boundaries && pnpm catalog --check
```
