# Blockspace Holdings monorepo

The shared platform and the three consumer products of Blockspace Holdings, in one pnpm workspace:

| Product | Slug | Verb | What it is | Status |
|---|---|---|---|---|
| [block.space](products/blockspace/README.md) | `blockspace` | measure | Bitcoin block-space explorer, fee Meter, portfolio, data API, certification | planned |
| [scribb.it](products/scribbit/README.md) | `scribbit` | write | Inscription engine, ledger, console, mint suite, API and MCP server | planned |
| [degent.club](products/degent/README.md) | `degent` | own | The Decentralized Gentlemen Club collection and its automated, non-custodial mint | beta |
| [platform](platform/README.md) | `platform` | - | Shared libraries: inscription maths, wallet adapters | beta |

Humans start here; agents start at [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md). Infrastructure (the Nix
fleet), chain nodes, data pipelines and forks live in separate repositories; see
[ADR-0001](docs/adr/0001-monorepo-structure.md).

## Quickstart

```bash
corepack enable                 # pnpm version comes from package.json "packageManager"
pnpm install
pnpm check                      # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm --filter @bsh/degent-web dev      # degent.club mint front end
pnpm --filter @bsh/degent-mint dev     # mint service with in-memory adapters (regtest-safe)
```

Every package answers to the same verbs: `pnpm --filter <pkg> test | typecheck | build | dev`.
New component: copy a skeleton from [`templates/`](templates/README.md).

## Layout

```
platform/<name>/                   shared libraries (@bsh/<name>)
products/<product>/apps/<name>/    deployable front ends
products/<product>/services/<name>/ deployable back ends
products/<product>/packages/<name>/ product-private libraries
contracts/{openapi,asyncapi,schemas}/  the only coupling between products
tools/catalog/                     manifest validator, boundary linter, catalog generator
catalog/                           GENERATED catalog.json + CATALOG.md
templates/                         copyable component skeletons (not workspace packages)
docs/adr/                          architecture decision records
schemas/component.schema.json      the component manifest schema
```

## The machine-readability model

The repository is built so CI, AI agents and the infra Fleet API can understand it **without reading code**.
Four layers, each checked in CI:

1. **Manifests.** Every workspace package has a `component.yaml` next to its `package.json`: name, kind, product,
   owner, lifecycle, `depends_on`, contracts it `provides`/`consumes`, stores, secret *paths*, SLO, runbook.
   Schema: [`schemas/component.schema.json`](schemas/component.schema.json). `pnpm validate` checks each manifest
   against the schema, against its `package.json`, and that every file it points at exists.
2. **Catalog.** `pnpm catalog` compiles all manifests into [`catalog/catalog.json`](catalog/catalog.json)
   (components with dependents, products, contracts with providers/consumers, a dependency edge list) and a human
   table in [`catalog/CATALOG.md`](catalog/CATALOG.md). It is committed; `pnpm catalog --check` fails CI when stale.
   `.github/CODEOWNERS` is generated from the same owners.
3. **Boundaries.** `pnpm lint:boundaries` parses every import. A component may import only the `@bsh/*` packages in
   its `depends_on`; products never import each other; `platform/` never imports `products/`; relative imports
   never leave the package. Findings are `file:line` with a stable rule id.
4. **Contracts.** Products talk to each other only through versioned OpenAPI / AsyncAPI / JSON Schema files in
   [`contracts/`](contracts/README.md). Contract first, then code; breaking changes are gated by `oasdiff`.

Design and rationale: [ADR-0001](docs/adr/0001-monorepo-structure.md) (structure) and
[ADR-0003](docs/adr/0003-machine-readable-catalog.md) (manifests, catalog, and the join with the infra Fleet API).
All decisions: [`docs/adr/`](docs/adr/README.md).
