# degent.club (DegentClub/degent)

This repository holds the **degent.club** product (own): the Decentralized Gentlemen Club collection and its
automated, non-custodial mint. The **shared platform** (`@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events`, …)
and the catalog tool come from `DegentClub/scribbit`, vendored as a git submodule pinned to a commit at
`deps/scribbit` (ADR-0004). Read this page first, then `products/degent/CLAUDE.md` and ADR-0002.

## Map

| Path | What lives there |
|---|---|
| `products/degent/apps/web/` | `@bsh/degent-web`: the degent.club website and mint front end (React + Vite) |
| `products/degent/services/mint/` | `@bsh/degent-mint`: order state machine, art review, policy signer, lane broadcaster |
| `products/degent/packages/mint-sdk/` | `@bsh/degent-mint-sdk`: mint rules, domain types, typed API client |
| `products/degent/services/telegram-gate/` | `@bsh/degent-telegram-gate`: holders-only Telegram gate (SIWB via `@bsh/identity`, Register holder check, invite by DM) |
| `products/degent/services/x-bot/` | `@bsh/degent-x-bot`: X content engine (approval tiers, content safety, Register-fact drafts, `brain/BRAIN.md`) |
| `products/degent/services/market/` | `@bsh/degent-market`: marketplace settlement engine (PSBT, FIFO via `@bsh/inscription`), SIWB listing auth, watcher; buys behind `BUYS_ENABLED` (ADR-0008) |
| `products/degent/packages/market-sdk/` | `@bsh/degent-market-sdk`: listing/buy types, settlement layout, royalty/fee maths, typed API client |
| `contracts/` | Contracts **this product provides**: `openapi/degent-mint.yaml`, `asyncapi/degent-mint.yaml`, `openapi/degent-telegram-gate.yaml`, `openapi/degent-market.yaml`, `asyncapi/degent-market.yaml`. Platform contracts are at `deps/scribbit/contracts/` |
| `deps/scribbit/` | SUBMODULE, read-only here: `platform/*`, `tools/catalog`, platform contracts, platform ADRs. Change it in DegentClub/scribbit, then bump the pin |
| `catalog/catalog.json` | GENERATED index of every component, platform ones marked `external` (`pnpm catalog`). Query this before grepping |
| `docs/adr/` | ADR-0002 (mint architecture), ADR-0005 (0x81 reveals, re-signed rescue), ADR-0007 (member approval + the Register), ADR-0008 (marketplace settlement). Platform ADRs: `deps/scribbit/docs/adr/`. Numbering is global across the three repos |
| `docs/REGISTER.md` | The on-chain roll: parent, Gallery, children, numbering, custody, the Register API |
| `roadmap.yaml` | Machine-readable roadmap (`schemas/roadmap.schema.json`); `pnpm test:root` validates it and every `verify` it names |
| `schemas/component.schema.json` | Copy of the platform's manifest schema; refresh it when bumping the pin. `roadmap.schema.json`, `register.schema.json`: our own |

Product slugs are fixed and used identically everywhere: `platform`, `blockspace`, `scribbit`, `degent`, `tooling`.
Only `degent` has code here.

## Rules

1. **Every workspace package has a `component.yaml`** that validates against
   `schemas/component.schema.json`. CI fails otherwise (`pnpm validate`).
2. **Imports follow declared dependencies.** A component may import another `@bsh/*` package only if it is listed
   in its `depends_on`; platform packages resolve from `deps/scribbit`. Never import `blockspace` or `scribbit`
   product code (it is not in this workspace anyway). Enforced by `pnpm lint:boundaries`.
3. **Contract first.** API or event changes start in `contracts/`. A contract lives with the component that
   provides it. The `degent.mint.order.{status}` topic is shared and **owned by the platform**
   (`deps/scribbit/contracts/asyncapi/platform-events.yaml`); our `contracts/asyncapi/degent-mint.yaml` must stay
   compatible (same required fields, same status enum) — `products/degent/services/mint/test/contract.test.ts`
   asserts it. Changing the shared topic means a platform PR first, then a pin bump, then this contract.
4. **Same verbs everywhere:** `pnpm --filter <pkg> test | typecheck | build | dev`. `pnpm check` runs everything
   CI runs (including the platform's tests at the pinned commit).
5. **No secrets in the repo.** Manifests list secret *paths*; values come from the secret store.
6. **Money paths are non-custodial by default.** Services never hold a user's private key.
   Read `docs/adr/0002-degent-mint-architecture.md` before touching any signing code.
7. **Tests are the spec.** New behaviour ships with tests; fee/size maths ships with property-style tests that
   compare predictions against real signed transactions.
8. **Never edit `deps/scribbit` in place.** Platform fixes go to DegentClub/scribbit; then bump the pin here:
   `git -C deps/scribbit fetch && git -C deps/scribbit checkout <commit> && pnpm install && pnpm check`
   (also `cp deps/scribbit/schemas/component.schema.json schemas/` when the schema changed, and `pnpm catalog`).

## Common tasks

```bash
git submodule update --init  # once, after cloning
pnpm install                 # once
pnpm check                   # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm contracts:diff          # statuses our AsyncAPI carries that the platform's shared topic does not (yet)
pnpm catalog                 # regenerate catalog/catalog.json
pnpm --filter @bsh/catalog-tool run codeowners --org DegentClub   # regenerate .github/CODEOWNERS
pnpm --filter @bsh/degent-web dev        # run the degent.club mint front end
pnpm --filter @bsh/degent-mint dev       # run the mint service (in-memory adapters, regtest-safe)
pnpm --filter @bsh/degent-market dev     # run the marketplace service (regtest, in-memory, buys paused)
```

## Adding a component

Copy `deps/scribbit/templates/library` (or `service`, `app`) into `products/degent/{packages,services,apps}/<name>`,
rename, fill in `component.yaml`, run `pnpm install && pnpm check && pnpm catalog`.
