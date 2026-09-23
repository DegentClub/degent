# Architecture decision records

One file per decision: `NNNN-kebab-title.md`, numbered sequentially. An accepted ADR is never edited except to
change its status; to change a decision, write a new ADR that supersedes it and link both ways.
Start from [`template.md`](template.md).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-structure.md) | One monorepo for platform and products, made legible by manifests, a catalog and boundaries | Accepted |
| [0002](0002-degent-mint-architecture.md) | degent.club automated mint: non-custodial, parent-linked, block-sized | Accepted |
| [0003](0003-machine-readable-catalog.md) | Machine-readable component catalog | Accepted |

Infrastructure decisions (fleet, networking, secrets, Fleet API) live in the `infra` repository's own ADR series
and are cited as `infra ADR-NNN`.
