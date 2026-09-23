# ADR-0001: One monorepo for platform and products, made legible by manifests, a catalog and boundaries

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** platform team
- **Components:** repository layout, `@bsh/catalog-tool`, `schemas/component.schema.json`

## Context

Blockspace Holdings ships three products that share one domain (Bitcoin block space and inscriptions):
**block.space** (measure), **scribb.it** (write) and **degent.club** (own). Before this repository their code was
spread across many small repositories with copy-pasted inscription maths, wallet adapters and API clients, which
drifted (the degent minter supported one wallet and computed fees differently from the Skrybit backend).

Most code in this estate will be written or changed by AI agents as well as humans. Agents do well when the
structure of a codebase is *declared* and cheap to query, and poorly when they must infer it by reading source.
The estate is expected to grow to millions of lines, so whatever we pick must stay legible at that size.

Some code has a different change cadence, toolchain or blast radius: the Nix/Proxmox fleet (`infra`), chain
nodes, data pipelines, forks of upstream projects and throwaway experiments.

## Decision

### 1. What lives here

One pnpm workspace holds **the shared platform and all product code**:

| Path | Content |
|---|---|
| `platform/<name>` | Libraries any product may use |
| `products/<product>/{apps,services,packages}/<name>` | Front ends, back ends, product-private libraries |
| `contracts/{openapi,asyncapi,schemas}` | The only allowed coupling between products |
| `tools/<name>` | Repo tooling |

### 2. What stays in separate repositories

| Repository family | Why separate |
|---|---|
| `infra` | Nix flakes, Terranix/OpenTofu, Colmena, SOPS. Different toolchain, operator-only access, deploys hosts rather than packages |
| `chain` | Node configuration, signet tooling, consensus-adjacent code with its own review bar |
| `data` | Indexers and ETL with heavy data dependencies and their own release rhythm |
| `fork-*` | Forks of upstream projects (e.g. `fork-ord`); must track upstream history cleanly |
| `lab-*` | Experiments and spikes; allowed to break every rule here, promoted by copying into a template |

These repositories reference this one through published contracts and, for infra, through the catalog
(ADR-0003), never through source imports.

### 3. Naming

- **Product slugs** are fixed and identical everywhere (folders, manifest `product:`, tags, owner teams):
  `platform`, `blockspace`, `scribbit`, `degent`, plus `tooling` for `tools/`. Dots and capitals never appear in slugs.
- **npm scope** is `@bsh` for every workspace package.
- **Names are kebab-case**: `^[a-z][a-z0-9-]*$`. Product-private components are prefixed with the product slug
  (`@bsh/degent-mint`, component `degent-mint`); platform components are not (`@bsh/inscription`).
- **Owners** are GitHub team slugs `team-<name>`.

### 4. Legibility is enforced, not documented

- Every workspace package has a `component.yaml` validated against `schemas/component.schema.json`.
- `catalog/catalog.json` is generated from the manifests and committed.
- `depends_on` is the allow-list for `@bsh/*` imports; products never import each other; platform never imports
  products; relative imports never leave a package.
- `.github/CODEOWNERS` is generated from manifest owners.

All four are checked by `@bsh/catalog-tool` in CI.

## Alternatives considered

- **Polyrepo (one repository per component).** Clear ownership and independent releases, but shared code is
  published and version-pinned per consumer, so fixes to fee maths propagate slowly and inconsistently, and no
  single place answers "what exists and what depends on what". Rejected for product and platform code; kept for the
  estate in section 2, where isolation is the point.
- **Bazel (or Buck2/Pants) now.** Hermetic builds, precise affected-target detection and remote caching at very
  large scale. Rejected *for now*: the codebase is TypeScript-only and small, the rules ecosystem for Vite/Vitest
  adds friction, and it would slow every contributor today for a benefit we do not need yet.
- **Bazel later.** Kept open deliberately. Manifests declare components and edges independently of the build tool,
  so a future migration can generate `BUILD` files from `catalog.json`. Revisit when any of these holds: full CI
  exceeds ~15 minutes with affected-only filtering, a second language needs first-class builds, or remote caching
  becomes the bottleneck.
- **Nx / Turborepo.** Useful task graphs and caching, but they infer structure from `package.json` and add their
  own config surface. pnpm filters (`--filter "...[origin/main]"`) give affected-only runs today; either can be
  added on top of the manifests later without changing them.

## Consequences

- One `pnpm install`, one lockfile, one CI pipeline; a platform fix reaches every product in the same commit.
- Adding a component costs a manifest. The templates in `templates/` make that a copy-and-rename.
- CI fails on undeclared structure (missing manifest, undeclared import, stale catalog), so the catalog can be
  trusted by machines.
- Cross-product features take two steps (contract, then code). That is intended friction.
- The single repository is a larger blast radius for access control; secrets never live here (manifests list
  secret paths only) and deploy credentials stay in `infra`.
