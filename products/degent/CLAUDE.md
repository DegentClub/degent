# degent.club - agent notes

Read the root `CLAUDE.md`, then [ADR-0002](../../docs/adr/0002-degent-mint-architecture.md). This product moves
real bitcoin; the rules below are not style preferences.

## Map

| Path | Package | Kind |
|---|---|---|
| `apps/web` | `@bsh/degent-web` | app (React + Vite) |
| `services/mint` | `@bsh/degent-mint` | service (Hono, ports and adapters) |
| `packages/mint-sdk` | `@bsh/degent-mint-sdk` | library (rules, types, API client) |

Query `catalog/catalog.json` (`.products.degent`, `.components[] | select(.product=="degent")`) for the current
dependency and contract graph instead of reading package.json files.

## Hard rules

1. **Non-custodial.** The service never holds a key that can move user funds. The ephemeral reveal key `K_e` is
   generated and discarded in the browser; the server only stores half-signed reveals.
2. **Only the policy signer signs the parent input**, and only transactions matching ADR-0002 section 3.
   Never widen its checks to make a test pass.
3. **One implementation of the maths.** Weight, fee and commit address come from `@bsh/inscription`; rules come
   from `@bsh/degent-mint-sdk`. Do not re-derive them in the app or the service.
4. **Contract first.** API or event changes start in `contracts/openapi/degent-mint.yaml` /
   `contracts/asyncapi/degent-mint.yaml`.
5. **Imports:** only `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/degent-mint-sdk`, each only where declared in
   that component's `depends_on`. Never import `blockspace` or `scribbit` code; `pnpm lint:boundaries` fails.
6. **Tests with fakes.** Service tests use the in-memory adapters (`memory-order-store`, `in-memory-policy-signer`,
   `rules-art-review`); nothing in tests touches mainnet.

## Verify before finishing

```bash
pnpm --filter "./products/degent/**" typecheck
pnpm --filter "./products/degent/**" test
pnpm validate && pnpm lint:boundaries && pnpm catalog --check
```
