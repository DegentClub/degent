# degent.club: own

**degent.club** is the Decentralized Gentlemen Club: a collection of 4,112 inscriptions and the automated,
non-custodial mint that lets anyone add a Degent, up to a block-sized one, from the website with no human in the
loop. This repository holds the product; the shared platform comes from
[DegentClub/scribbit](https://github.com/DegentClub/scribbit) as a git submodule pinned to a commit at
`deps/scribbit` ([ADR-0004](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0004-repo-split.md)).

| Repository | What it is |
|---|---|
| **DegentClub/degent** (this repo) | `degent-web` (the degent.club website and mint front end), `degent-mint` (mint service), `degent-mint-sdk` (rules, types, API client), `degent-telegram-gate` (holders-only Telegram gate), `degent-x-bot` (X content engine), `degent-market` + `degent-market-sdk` (marketplace), their contracts, ADRs |
| [DegentClub/scribbit](https://github.com/DegentClub/scribbit) | The platform: `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events`, `@bsh/edge`, …, the catalog tool, scribb.it |
| [DegentClub/blockspace](https://github.com/DegentClub/blockspace) | block.space: explorer, fee Meter, certification |

Humans start here and at [`products/degent/README.md`](products/degent/README.md); agents start at
[`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md).

## Quickstart

```bash
git clone --recurse-submodules https://github.com/DegentClub/degent.git   # or: git submodule update --init
corepack enable                        # pnpm version comes from package.json "packageManager"
pnpm install
pnpm check                             # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm --filter @bsh/degent-web dev      # degent.club website + mint (add ?demo=1)
pnpm --filter @bsh/degent-mint dev     # mint service with in-memory adapters (regtest-safe)
pnpm --filter @bsh/degent-market dev   # marketplace service (regtest, in-memory, buys paused)
```

Every package answers to the same verbs: `pnpm --filter <pkg> test | typecheck | build | dev`. `pnpm test` also
runs the platform's tests at the pinned commit (they live in the workspace through the submodule).

## Layout

```
products/degent/apps/web/          @bsh/degent-web        degent.club website + mint front end (React + Vite)
products/degent/services/mint/     @bsh/degent-mint       order state machine, art review, policy signer, lanes
products/degent/packages/mint-sdk/ @bsh/degent-mint-sdk   rules, domain types, typed API client
products/degent/services/telegram-gate/ @bsh/degent-telegram-gate  holders-only Telegram gate (SIWB + Register, invite by DM)
products/degent/services/x-bot/    @bsh/degent-x-bot      X content engine: approval tiers, safety, Register-fact drafts
products/degent/services/market/   @bsh/degent-market     marketplace: PSBT settlement, SIWB listing auth, watcher (buys off by default)
products/degent/packages/market-sdk/ @bsh/degent-market-sdk listing/buy types, layout, royalty/fee maths, typed API client
contracts/openapi/degent-mint.yaml     HTTP API of degent-mint (provided here)
contracts/asyncapi/degent-mint.yaml    degent.mint.* order events (provided here; compatible with the platform topic)
contracts/openapi/degent-telegram-gate.yaml  HTTP API of degent-telegram-gate (provided here; consumed by degent-web /verify)
contracts/openapi/degent-market.yaml   HTTP API of degent-market (provided here)
contracts/asyncapi/degent-market.yaml  degent.market.listing.{status} events (provided here; owned by this product)
deps/scribbit/                     SUBMODULE: the platform (platform/*), catalog tool (tools/catalog), platform contracts
catalog/                           GENERATED catalog.json + CATALOG.md (platform components listed as external)
docs/adr/                          ADR-0002 (mint), 0005, 0007, 0008 (marketplace settlement); platform ADRs in deps/scribbit/docs/adr/
schemas/component.schema.json      copy of the platform's manifest schema (refresh on pin bumps)
```

## The platform submodule

`pnpm-workspace.yaml` includes `deps/scribbit/platform/*` and `deps/scribbit/tools/*`, so `workspace:*` dependencies
on `@bsh/inscription`, `@bsh/wallet-kit`, `@bsh/events` and the `@bsh/catalog-tool` behind `pnpm validate`,
`pnpm lint:boundaries` and `pnpm catalog` all resolve from the pinned commit. To move to a newer platform commit:

```bash
git -C deps/scribbit fetch && git -C deps/scribbit checkout <commit> && pnpm install && pnpm check
cp deps/scribbit/schemas/component.schema.json schemas/   # if the schema changed
pnpm catalog && git add deps/scribbit schemas catalog pnpm-lock.yaml && git commit -m "Bump platform to <commit>"
```

The catalog tool treats the submodule's packages as **external** components: `catalog/catalog.json` lists them with
`external: { repo, commit, root }`, so a machine can follow the link to the platform's own catalog.

## Contracts

- `contracts/openapi/degent-mint.yaml`: provided by `degent-mint` and `degent-mint-sdk`, consumed by `degent-web`,
  `degent-telegram-gate` (Register holder check) and `degent-x-bot` (Register facts, stats).
- `contracts/openapi/degent-telegram-gate.yaml`: provided by `degent-telegram-gate`, consumed by `degent-web` (`/verify`).
- `contracts/asyncapi/degent-mint.yaml`: `degent.mint.order.{status}` events, provided by `degent-mint`. The shared
  topic is owned by the platform (`deps/scribbit/contracts/asyncapi/platform-events.yaml`); a test in
  `products/degent/services/mint/test/contract.test.ts` asserts this contract stays compatible with it.
- `contracts/openapi/degent-market.yaml`: provided by `degent-market` and `degent-market-sdk` (marketplace, ADR-0008).
- `contracts/asyncapi/degent-market.yaml`: `degent.market.listing.{status}` events, provided by `degent-market` and
  owned by this product; `products/degent/services/market/test/contract.test.ts` asserts routes, errors, enums and
  live payloads against both files.
- Consumes `events:block.indexed.{network}` from the chain indexers.

## The machine-readability model

Same as the platform repo: every workspace package has a `component.yaml` validated by `pnpm validate`; the
committed `catalog/catalog.json` is regenerated by `pnpm catalog` and checked in CI; `pnpm lint:boundaries` enforces
that imports follow `depends_on`; `.github/CODEOWNERS` is generated from manifest owners. Rationale:
[ADR-0001](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0001-monorepo-structure.md),
[ADR-0003](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0003-machine-readable-catalog.md),
[ADR-0004](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0004-repo-split.md).
