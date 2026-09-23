# Blockspace Holdings monorepo

One repository for the shared platform and the three products: **block.space** (measure),
**scribb.it** (write) and **degent.club** (own). Read this page first. It is deliberately
short; each product and package has its own `CLAUDE.md` / `README.md` with local detail.

## Map

| Path | What lives there |
|---|---|
| `platform/` | Shared libraries every product may use (`@bsh/inscription`, `@bsh/wallet-kit`, …) |
| `products/<product>/apps/` | Deployable front ends |
| `products/<product>/services/` | Deployable back-end services |
| `products/<product>/packages/` | Libraries private to one product (SDKs, rules) |
| `contracts/` | OpenAPI / AsyncAPI / JSON Schema. **The only allowed coupling between products** |
| `tools/` | Repo tooling: catalog generator, boundary linter |
| `catalog/catalog.json` | GENERATED index of every component (`pnpm catalog`). Query this before grepping |
| `docs/adr/` | Architecture decisions. Numbered, never edited after acceptance (supersede instead) |
| `schemas/component.schema.json` | The manifest schema every component must satisfy |

Product slugs are fixed and used identically everywhere (folders, `product:` fields, tags):
`platform`, `blockspace`, `scribbit`, `degent`, `tooling`.

## Rules

1. **Every workspace package has a `component.yaml`** that validates against
   `schemas/component.schema.json`. CI fails otherwise (`pnpm validate`).
2. **Imports follow declared dependencies.** A component may import another `@bsh/*` package only
   if it is listed in its `depends_on`. Products never import another product's code;
   `platform/*` never imports `products/*`. Enforced by `pnpm lint:boundaries`.
3. **Cross-product traffic goes through `contracts/`.** Change the contract first, then the code.
4. **Same verbs everywhere:** `pnpm --filter <pkg> test | typecheck | build | dev`.
   `pnpm check` runs everything CI runs.
5. **No secrets in the repo.** Manifests list secret *paths*; values come from the secret store.
6. **Money paths are non-custodial by default.** Services never hold a user's private key.
   Read `docs/adr/0002-degent-mint-architecture.md` before touching any signing code.
7. **Tests are the spec.** New behaviour ships with tests; fee/size maths ships with
   property-style tests that compare predictions against real signed transactions.

## Common tasks

```bash
pnpm install                 # once
pnpm check                   # validate manifests + boundaries + typecheck + tests (what CI runs)
pnpm catalog                 # regenerate catalog/catalog.json
pnpm --filter @bsh/degent-web dev        # run the degent.club mint front end
pnpm --filter @bsh/degent-mint dev       # run the mint service (in-memory adapters, regtest-safe)
```

## Adding a component

Copy `templates/library` (or `service`, `app`), rename, fill in `component.yaml`, run `pnpm check`.
